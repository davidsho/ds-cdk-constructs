import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

export function hostHeaderCode(): cloudfront.FunctionCode {
    return cloudfront.FunctionCode.fromInline(
`function handler(event) {
    var request = event.request;
    request.headers['x-forwarded-host'] = { value: request.headers.host.value };
    return request;
}
`,
    );
}

/**
 * Injects `x-forwarded-host` and 301s anything that did not arrive on a
 * canonical host to the apex domain.
 *
 * `canonicalHosts` is every name the distribution is meant to answer on: the
 * apex plus any `additionalDomainNames`. Everything else redirects, which
 * matters most for the distribution's own `*.cloudfront.net` name. That name
 * always resolves and cannot be turned off, so without this the site has two
 * live addresses serving identical HTML, each with a self-referencing
 * canonical tag. Search engines treat that as duplicate content, and the
 * CloudFront URL is the copy nobody wants indexed.
 *
 * `www` is deliberately not canonical. It stays an alias so the certificate
 * covers it and visitors who type it land somewhere, but it redirects to the
 * apex like everything else.
 *
 * Only use this when the distribution actually has aliases attached. With no
 * custom domain the CloudFront URL is the only way in, and redirecting it
 * would take the site off the internet.
 */
export function hostHeaderWithCanonicalRedirectCode(
    apexDomain: string,
    canonicalHosts: readonly string[],
): cloudfront.FunctionCode {
    const canonical = JSON.stringify(canonicalHosts.map((h) => h.toLowerCase()));
    return cloudfront.FunctionCode.fromInline(
`function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;
    request.headers['x-forwarded-host'] = { value: host };
    var canonicalHosts = ${canonical};
    if (canonicalHosts.indexOf(host.toLowerCase()) !== -1) {
        return request;
    }
    var qsParts = [];
    for (var key in request.querystring) {
        var qs = request.querystring[key];
        if (qs && qs.multiValue) {
            for (var i = 0; i < qs.multiValue.length; i++) {
                qsParts.push(key + '=' + qs.multiValue[i].value);
            }
        } else if (qs && qs.value !== undefined) {
            qsParts.push(key + '=' + qs.value);
        }
    }
    var querystring = qsParts.length > 0 ? '?' + qsParts.join('&') : '';
    return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
            'location': { value: 'https://${apexDomain}' + request.uri + querystring },
            'cache-control': { value: 'max-age=31536000' }
        }
    };
}
`,
    );
}
