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

export function hostHeaderWithWwwRedirectCode(domain: string): cloudfront.FunctionCode {
    return cloudfront.FunctionCode.fromInline(
`function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;
    request.headers['x-forwarded-host'] = { value: host };
    if (host.toLowerCase() === 'www.${domain}') {
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
                'location': { value: 'https://${domain}' + request.uri + querystring },
                'cache-control': { value: 'max-age=31536000' }
            }
        };
    }
    return request;
}
`,
    );
}
