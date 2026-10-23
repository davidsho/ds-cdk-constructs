var REDIRECTS = {"/contact-us/":"/contact","/services/":"/#what-we-make","/blog/old-post":"/writing/old-post","/terms/":"/terms"};
var CANONICAL_HOSTS = ["example.com","members.example.com"];

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

    var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
    if (host && CANONICAL_HOSTS.indexOf(host) === -1) {
        return permanentRedirect('https://example.com' + uri + querystring(request));
    }

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
