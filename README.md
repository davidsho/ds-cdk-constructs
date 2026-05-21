# @davidsho/cdk-constructs

L3 CDK constructs for Angular SSR deployments on AWS.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Requirements

- Node.js >= 18
- `aws-cdk-lib` >= 2.243.0
- `constructs` >= 10.5.1

## Install

Hosted on GitHub Packages. Add the following to your `.npmrc`:

```
@davidsho:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

A GitHub Personal Access Token with `read:packages` scope is required. Then:

```bash
npm install @davidsho/cdk-constructs
```

## `AngularSsrDistribution`

A single CloudFront distribution that fronts:

- A Lambda Function URL for the default behaviour, running the Angular SSR server via the Lambda Web Adapter
- An S3 bucket for hashed and unhashed static assets (`*.js`, `*.css`, `*.svg`, `*.png`, `*.jpg`, `*.webp`, `*.woff2`, `site.webmanifest` by default)
- A viewer-request CloudFront Function that injects `x-forwarded-host` (and, when a custom domain is set, redirects `www.` to apex)
- Strict security headers and HSTS, with a user-supplied CSP

### Minimal usage (no custom domain)

```ts
import * as path from 'path';
import {AngularSsrDistribution} from '@davidsho/cdk-constructs';

new AngularSsrDistribution(this, 'Ssr', {
    serverDistPath: path.join(__dirname, '../../web-app-dist/server'),
    browserDistPath: path.join(__dirname, '../../web-app-dist/browser'),
    contentSecurityPolicy: "default-src 'self'",
});
```

The site is served from the default CloudFront URL.

### With a custom domain

```ts
const ssr = new AngularSsrDistribution(this, 'Ssr', {
    serverDistPath: path.join(__dirname, '../../web-app-dist/server'),
    browserDistPath: path.join(__dirname, '../../web-app-dist/browser'),
    contentSecurityPolicy: buildCsp(),

    domainName: 'example.com',
    certificate,
    hostedZone,
    additionalDomainNames: ['members.example.com'],
});
```

The certificate must already include every entry in `additionalDomainNames` in its `subjectAlternativeNames`. The construct does not modify the certificate.

### With an API behaviour

```ts
const apiBehavior: cloudfront.BehaviorOptions = {
    origin: new origins.HttpOrigin(apiDomain, {...}),
    // ...
};

new AngularSsrDistribution(this, 'Ssr', {
    // ...
    additionalBehaviors: {'api/*': apiBehavior},
});
```

`additionalBehaviors` is merged in before the static-asset catch-alls, so `api/*` always wins over `*.js` and friends.

### Removal policy

The S3 assets bucket defaults to `RemovalPolicy.DESTROY` with `autoDeleteObjects: true`, because the contents are regenerated on every deploy. If you want the bucket (and its objects) to survive stack deletion, pass `bucketRemovalPolicy: cdk.RemovalPolicy.RETAIN`.

### Extending the SSR Lambda or assets bucket

`ssrFunction` and `assetsBucket` are exposed as public readonly properties. Use them to grant extra permissions, add extra deployments, or attach further integrations:

```ts
const ssr = new AngularSsrDistribution(this, 'Ssr', {...});

mySecret.grantRead(ssr.ssrFunction);

new s3deploy.BucketDeployment(this, 'ExtraAssets', {
    destinationBucket: ssr.assetsBucket,
    sources: [s3deploy.Source.asset('extra-public')],
});
```

## `invalidateCdnStep`

Helper for CodePipeline post-deploy invalidation. Accepts either an `AngularSsrDistribution` directly, or the `distributionIdOutput` `CfnOutput` it exposes:

```ts
import {invalidateCdnStep} from '@davidsho/cdk-constructs';

pipeline.addStage(stage, {
    post: [invalidateCdnStep(stage.webStack.ssr)],
    // or, equivalently:
    // post: [invalidateCdnStep(stage.webStack.ssr.distributionIdOutput)],
});
```
