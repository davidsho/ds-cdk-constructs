import * as fs from 'fs';
import * as path from 'path';

/**
 * CloudFront limits an inline function to 10 KB of code. The redirect manifest
 * is baked into the source, so a large enough manifest silently pushes the
 * function over the edge. Checked at synth time instead.
 */
export const FUNCTION_SIZE_LIMIT_BYTES = 10240;

export interface StaticViewerRequestOptions {
    /**
     * Legacy path -> new path, both root-relative. Matched exactly, with
     * trailing-slash tolerance in both directions, so '/contact-us/' and
     * '/contact-us' resolve to the same entry.
     */
    readonly redirects?: Record<string, string>;

    /**
     * Apex domain that non-canonical hosts are redirected to. Omit when the
     * distribution has no custom domain: the CloudFront URL is then the only
     * way in, and redirecting it would take the site off the internet.
     */
    readonly apexDomain?: string;

    /**
     * Every host the distribution is meant to answer on without redirecting.
     * Defaults to the apex alone, which is what sends www and the
     * *.cloudfront.net name to the apex. That name always resolves and cannot
     * be turned off, so without this the site has two live addresses serving
     * identical HTML and search engines see duplicate content.
     */
    readonly canonicalHosts?: readonly string[];
}

/**
 * Read a build-generated redirect manifest from disk.
 *
 * Kept separate from the construct so the construct stays pure: callers that
 * already have the mapping in hand pass `redirects` directly.
 */
export function readRedirectManifest(manifestPath: string): Record<string, string> {
    const resolved = path.resolve(manifestPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(
            `Redirect manifest not found at ${resolved}. Build the web app before synthesising.`,
        );
    }

    return JSON.parse(fs.readFileSync(resolved, 'utf8')) as Record<string, string>;
}

/**
 * Viewer-request function for a prerendered site served straight from S3.
 *
 * It does the three jobs an origin application would otherwise be kept alive
 * for: canonical host redirects, legacy URL redirects, and resolving a clean
 * path like /about to the /about/index.html key that actually exists in the
 * bucket. S3 origins do no directory-index resolution of their own beyond the
 * root object, so without the rewrite every nested route 404s.
 */
export function buildStaticViewerRequestCode(options: StaticViewerRequestOptions): string {
    const {redirects = {}, apexDomain, canonicalHosts} = options;

    if (canonicalHosts?.length && !apexDomain) {
        throw new Error('canonicalHosts requires apexDomain: there is nothing to redirect to');
    }

    const hosts = (canonicalHosts?.length ? canonicalHosts : apexDomain ? [apexDomain] : [])
        .map((h) => h.toLowerCase());

    const canonicalHostRedirect = apexDomain
        ? `
    var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
    if (host && CANONICAL_HOSTS.indexOf(host) === -1) {
        return permanentRedirect('https://${apexDomain}' + uri + querystring(request));
    }
`
        : '';

    const code = `var REDIRECTS = ${JSON.stringify(redirects)};
var CANONICAL_HOSTS = ${JSON.stringify(hosts)};

function querystring(request) {
    var parts = [];
    for (var key in request.querystring) {
        var value = request.querystring[key];
        if (value && value.multiValue) {
            for (var i = 0; i < value.multiValue.length; i++) {
                parts.push(key + '=' + value.multiValue[i].value);
            }
        } else if (value && value.value !== undefined) {
            parts.push(key + '=' + value.value);
        }
    }
    return parts.length > 0 ? '?' + parts.join('&') : '';
}

function permanentRedirect(location) {
    return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
            'location': { value: location },
            'cache-control': { value: 'max-age=3600' }
        }
    };
}

function legacyTarget(uri) {
    var target = null;
    if (REDIRECTS[uri]) {
        target = REDIRECTS[uri];
    } else if (uri.charAt(uri.length - 1) !== '/' && REDIRECTS[uri + '/']) {
        target = REDIRECTS[uri + '/'];
    } else if (uri.length > 1 && uri.charAt(uri.length - 1) === '/') {
        var trimmed = uri.slice(0, -1);
        if (REDIRECTS[trimmed]) {
            target = REDIRECTS[trimmed];
        }
    }
    return target === uri ? null : target;
}

function handler(event) {
    var request = event.request;
    var uri = request.uri;
${canonicalHostRedirect}
    var target = legacyTarget(uri);
    if (target) {
        return permanentRedirect(target + querystring(request));
    }

    if (uri.charAt(uri.length - 1) === '/') {
        request.uri = uri + 'index.html';
        return request;
    }

    var lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
        request.uri = uri + '/index.html';
    }

    return request;
}
`;

    const size = Buffer.byteLength(code, 'utf8');
    if (size > FUNCTION_SIZE_LIMIT_BYTES) {
        throw new Error(
            `Viewer request function is ${size} bytes, over the CloudFront limit of `
            + `${FUNCTION_SIZE_LIMIT_BYTES}. Move the ${Object.keys(redirects).length} redirects `
            + 'into a CloudFront KeyValueStore.',
        );
    }

    return code;
}
