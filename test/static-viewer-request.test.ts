import * as fs from 'fs';
import * as path from 'path';
import {
    FUNCTION_SIZE_LIMIT_BYTES,
    buildStaticViewerRequestCode,
    hashBasicAuthCredential,
} from '../src/static-viewer-request';

const APEX = 'example.com';
const CLOUDFRONT_HOST = 'd1234abcdefgh.cloudfront.net';

const REDIRECTS: Record<string, string> = {
    '/contact-us/': '/contact',
    '/services/': '/#what-we-make',
    '/blog/old-post': '/writing/old-post',
    // Key whose target is the key without its trailing slash. Without the
    // self-reference guard, /terms looks up /terms/ and 301s to itself, which
    // browsers show as ERR_TOO_MANY_REDIRECTS.
    '/terms/': '/terms',
};

type ViewerEvent = {
    request: {
        uri: string;
        querystring: Record<string, {value?: string; multiValue?: {value: string}[]}>;
        headers: Record<string, {value: string}>;
    };
};

type ViewerResult = {
    uri?: string;
    statusCode?: number;
    headers?: Record<string, {value: string}>;
};

const GOLDEN = path.join(__dirname, 'fixtures', 'v2.3.0');

function load(options: Parameters<typeof buildStaticViewerRequestCode>[0]) {
    const code = buildStaticViewerRequestCode(options);
    // CloudFront Functions provide require() for the crypto module; Node's is
    // API-compatible for the createHash calls the basic auth check makes.
    const handler = new Function('require', `${code}; return handler;`)(require) as (e: ViewerEvent) => ViewerResult;
    return {handler, size: Buffer.byteLength(code, 'utf8')};
}

function event(
    uri: string,
    host = APEX,
    querystring: ViewerEvent['request']['querystring'] = {},
    authorization?: string,
): ViewerEvent {
    const headers: ViewerEvent['request']['headers'] = {host: {value: host}};
    if (authorization !== undefined) {
        headers.authorization = {value: authorization};
    }
    return {request: {uri, querystring, headers}};
}

function basic(credential: string): string {
    return `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        console.log(`pass  ${label}`);
        return;
    }
    failures++;
    console.log(`FAIL  ${label}`);
    console.log(`        got  ${JSON.stringify(actual)}`);
    console.log(`        want ${JSON.stringify(expected)}`);
}

function throws(label: string, fn: () => unknown): void {
    try {
        fn();
    } catch {
        console.log(`pass  ${label}`);
        return;
    }
    failures++;
    console.log(`FAIL  ${label}`);
    console.log('        expected a throw, got none');
}

function redirect(result: ViewerResult): [number | undefined, string | undefined] {
    return [result.statusCode, result.headers?.location.value];
}

const plain = load({redirects: REDIRECTS});
const withApex = load({redirects: REDIRECTS, apexDomain: APEX, canonicalHosts: [APEX]});
const withExtra = load({
    redirects: REDIRECTS,
    apexDomain: APEX,
    canonicalHosts: [APEX, `members.${APEX}`],
});

// ── directory index resolution ──────────────────────────────────────────
check('page without trailing slash rewrites to index.html', plain.handler(event('/about')).uri, '/about/index.html');
check('page with trailing slash rewrites to index.html', plain.handler(event('/about/')).uri, '/about/index.html');
check('nested page rewrites to index.html', plain.handler(event('/writing/some-post')).uri, '/writing/some-post/index.html');
check('root rewrites to index.html', plain.handler(event('/')).uri, '/index.html');
check('hashed bundle passes through untouched', plain.handler(event('/main-NLRD5BCZ.js')).uri, '/main-NLRD5BCZ.js');
check('image passes through untouched', plain.handler(event('/img/photo-800.webp')).uri, '/img/photo-800.webp');
check('sitemap passes through untouched', plain.handler(event('/sitemap.xml')).uri, '/sitemap.xml');

// ── legacy redirects ────────────────────────────────────────────────────
check('legacy redirect on the exact key', redirect(plain.handler(event('/contact-us/'))), [301, '/contact']);
check('legacy redirect without the trailing slash', redirect(plain.handler(event('/contact-us'))), [301, '/contact']);
check('legacy redirect carrying a fragment', redirect(plain.handler(event('/services/'))), [301, '/#what-we-make']);
check('renamed url space redirects', redirect(plain.handler(event('/blog/old-post'))), [301, '/writing/old-post']);
check('a self-referencing redirect key does not loop', plain.handler(event('/terms')).uri, '/terms/index.html');
check('the trailing-slash form still redirects', redirect(plain.handler(event('/terms/'))), [301, '/terms']);
check('an unmapped path is not redirected', plain.handler(event('/unknown')).uri, '/unknown/index.html');
check(
    'redirect preserves the query string',
    plain.handler(event('/contact-us/', APEX, {utm_source: {value: 'newsletter'}})).headers?.location.value,
    '/contact?utm_source=newsletter',
);
check(
    'redirect preserves a multi-value query string',
    plain.handler(event('/contact-us/', APEX, {tag: {multiValue: [{value: 'a'}, {value: 'b'}]}})).headers?.location.value,
    '/contact?tag=a&tag=b',
);

// ── canonical host handling ─────────────────────────────────────────────
check('www serves the site when no domain is configured', plain.handler(event('/about', `www.${APEX}`)).uri, '/about/index.html');
check('the cloudfront domain serves the site when no domain is configured', plain.handler(event('/about', CLOUDFRONT_HOST)).uri, '/about/index.html');
check('www redirects to apex when configured', redirect(withApex.handler(event('/about', `www.${APEX}`))), [301, `https://${APEX}/about`]);
check('the cloudfront domain redirects to apex', redirect(withApex.handler(event('/about', CLOUDFRONT_HOST))), [301, `https://${APEX}/about`]);
check('the cloudfront domain redirects from the root as well', redirect(withApex.handler(event('/', CLOUDFRONT_HOST))), [301, `https://${APEX}/`]);
check('an unknown host redirects to apex', redirect(withApex.handler(event('/about', 'random.example.net'))), [301, `https://${APEX}/about`]);
check('apex is left alone', withApex.handler(event('/about', APEX)).uri, '/about/index.html');
check('host matching is case insensitive', withApex.handler(event('/about', APEX.toUpperCase())).uri, '/about/index.html');
check(
    'the host redirect keeps the query string',
    withApex.handler(event('/contact', CLOUDFRONT_HOST, {utm_source: {value: 'x'}})).headers?.location.value,
    `https://${APEX}/contact?utm_source=x`,
);
check(
    'host redirect wins over a legacy redirect',
    withApex.handler(event('/contact-us/', `www.${APEX}`)).headers?.location.value,
    `https://${APEX}/contact-us/`,
);
check('a missing host header does not redirect', withApex.handler({request: {uri: '/about', querystring: {}, headers: {}}}).uri, '/about/index.html');
check('an additional canonical host serves the site', withExtra.handler(event('/about', `members.${APEX}`)).uri, '/about/index.html');
check('a non-canonical host still redirects when extras are configured', redirect(withExtra.handler(event('/about', CLOUDFRONT_HOST))), [301, `https://${APEX}/about`]);

// ── basic auth ──────────────────────────────────────────────────────────
const READERS = ['david:correct horse', 'reviewer:pa:ss:word'];
const guarded = load({
    redirects: REDIRECTS,
    apexDomain: APEX,
    canonicalHosts: [APEX],
    basicAuth: {credentialHashes: READERS.map(hashBasicAuthCredential), realm: 'Preview'},
});

check(
    'the digest is sha256 of the base64 token (independent reference value)',
    hashBasicAuthCredential('user:pass'),
    '0e9d220616f08345a714ee57d8516310770588484b5239844635f952965e34a6',
);
check('no credentials are challenged', guarded.handler(event('/about')).statusCode, 401);
check(
    'the challenge names the realm and asks for UTF-8',
    guarded.handler(event('/about')).headers?.['www-authenticate'].value,
    'Basic realm="Preview", charset="UTF-8"',
);
check('the challenge is never cached', guarded.handler(event('/about')).headers?.['cache-control'].value, 'no-store');
check('the right credentials are let through', guarded.handler(event('/about', APEX, {}, basic(READERS[0]))).uri, '/about/index.html');
check('every listed reader is let through', guarded.handler(event('/', APEX, {}, basic(READERS[1]))).uri, '/index.html');
check('the scheme is case insensitive', guarded.handler(event('/', APEX, {}, basic(READERS[0]).replace('Basic', 'basic'))).uri, '/index.html');
check('a wrong password is challenged', guarded.handler(event('/about', APEX, {}, basic('david:wrong'))).statusCode, 401);
check('an unknown user is challenged', guarded.handler(event('/about', APEX, {}, basic('someone:correct horse'))).statusCode, 401);
check('a non-basic scheme is challenged', guarded.handler(event('/about', APEX, {}, 'Bearer abc')).statusCode, 401);
check('an empty authorization header is challenged', guarded.handler(event('/about', APEX, {}, '')).statusCode, 401);
check('assets are guarded as well as pages', guarded.handler(event('/main-NLRD5BCZ.js')).statusCode, 401);
check('legacy redirects are not served before login', guarded.handler(event('/contact-us/')).statusCode, 401);
check(
    'legacy redirects still work after login',
    redirect(guarded.handler(event('/contact-us/', APEX, {}, basic(READERS[0])))),
    [301, '/contact'],
);
check(
    'non-canonical hosts redirect before the challenge, so the login is asked for once',
    redirect(guarded.handler(event('/about', `www.${APEX}`))),
    [301, `https://${APEX}/about`],
);
check(
    'basic auth works without a custom domain',
    load({basicAuth: {credentialHashes: [hashBasicAuthCredential(READERS[0])]}}).handler(event('/about', CLOUDFRONT_HOST)).statusCode,
    401,
);
check(
    'the realm defaults to Restricted',
    load({basicAuth: {credentialHashes: [hashBasicAuthCredential(READERS[0])]}}).handler(event('/')).headers?.['www-authenticate'].value,
    'Basic realm="Restricted", charset="UTF-8"',
);
check('the function never contains a password', buildStaticViewerRequestCode({
    basicAuth: {credentialHashes: READERS.map(hashBasicAuthCredential)},
}).includes('correct horse'), false);
check(`guarded function is within the ${FUNCTION_SIZE_LIMIT_BYTES} byte limit (${guarded.size} bytes)`, guarded.size <= FUNCTION_SIZE_LIMIT_BYTES, true);
throws('an empty credential list is rejected', () => buildStaticViewerRequestCode({basicAuth: {credentialHashes: []}}));
throws('a plaintext credential in place of a hash is rejected', () => buildStaticViewerRequestCode({
    basicAuth: {credentialHashes: ['david:correct horse']},
}));
throws('a realm that would break the header is rejected', () => buildStaticViewerRequestCode({
    basicAuth: {credentialHashes: [hashBasicAuthCredential(READERS[0])], realm: 'a"b'},
}));

// ── unchanged for existing consumers ────────────────────────────────────
// Byte-for-byte against what 2.3.0 generated. A difference here redeploys the
// function of every site that upgrades, so it has to be deliberate.
check(
    'output without the new options matches 2.3.0 (no domain)',
    buildStaticViewerRequestCode({redirects: REDIRECTS}),
    fs.readFileSync(path.join(GOLDEN, 'viewer-request-plain.js'), 'utf8'),
);
check(
    'output without the new options matches 2.3.0 (canonical hosts)',
    buildStaticViewerRequestCode({redirects: REDIRECTS, apexDomain: APEX, canonicalHosts: [APEX, `members.${APEX}`]}),
    fs.readFileSync(path.join(GOLDEN, 'viewer-request-apex.js'), 'utf8'),
);

// ── synth-time guards ───────────────────────────────────────────────────
check(`function is within the ${FUNCTION_SIZE_LIMIT_BYTES} byte limit (${withApex.size} bytes)`, withApex.size <= FUNCTION_SIZE_LIMIT_BYTES, true);
throws('canonicalHosts without apexDomain is rejected', () => buildStaticViewerRequestCode({canonicalHosts: [APEX]}));
throws('an oversized redirect manifest is rejected', () => buildStaticViewerRequestCode({
    redirects: Object.fromEntries(
        Array.from({length: 400}, (_, i) => [`/legacy/page-number-${i}/`, `/new/page-number-${i}`]),
    ),
}));

console.log('');
if (failures > 0) {
    console.log(`${failures} failing`);
    process.exit(1);
}
console.log('all static viewer request checks passed');
