# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-05-22

### Fixed
- `AngularSsrDistribution` now creates its Route 53 alias records at the
  correct name when `domainName` is a *subdomain* of the supplied
  `hostedZone`. Previously the apex/www/extra `ARecord`s were always written
  at the zone apex regardless of `domainName`, which collided with any
  existing apex record (e.g. when adding a second app under the same hosted
  zone). When `domainName` equals the zone apex the behaviour is unchanged.
- A clearer error is thrown if `domainName` (or any entry in
  `additionalDomainNames`) is not contained within the supplied `hostedZone`.

## [2.0.0] - 2026-05-21

### Added
- `lambdaRuntime`, `lambdaTimeout`, and `lambdaArchitecture` props on `AngularSsrDistribution`. The Lambda Web Adapter layer ARN is now derived from `lambdaArchitecture` and `stack.region`; override with `webAdapterLayerArn` only for custom-built layers.
- `redirectWwwToApex` prop (default `true`) controlling the www → apex alias and 301 redirect.
- `permissionsPolicy` prop, applied by default as `camera=(), microphone=(), geolocation=()`. Pass `''` to omit the header.
- `frameOption`, `allowedMethods`, `cacheQueryStrings`, `additionalBehaviors`, `additionalStaticPatterns`, `priceClass`, and `bucketRemovalPolicy` props.
- `responseHeadersPolicy` and `viewerRequestFunction` exposed as `public readonly` on `AngularSsrDistribution`.
- `distributionId` getter on `AngularSsrDistribution` (in addition to the existing `distributionIdOutput`).
- `invalidateCdnStep` now accepts an `AngularSsrDistribution` directly, in addition to the existing `CfnOutput` form.
- MIT `LICENSE` file.

### Changed
- `cachePolicyName` and `securityHeadersPolicyName` are now optional. They default to `${stack.stackName}-${id}-Cache` and `${stack.stackName}-${id}-SecurityHeaders` respectively. Passing them explicitly still works.
- Viewer-request CloudFront Function moved into its own module (`viewer-request.ts`); behaviour is unchanged.

## [1.0.0] - 2026-05-20

Initial release.
