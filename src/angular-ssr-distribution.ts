import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import {Construct} from 'constructs';
import {hostHeaderCode, hostHeaderWithWwwRedirectCode} from './viewer-request';

const DEFAULT_WEB_ADAPTER_LAYER_VERSION = 25;

const DEFAULT_STATIC_PATTERNS = [
    '*.js', '*.css', '*.svg', '*.png', '*.jpg', '*.webp',
    '*.woff2', 'site.webmanifest',
];

const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

export interface AngularSsrDistributionProps {
    serverDistPath: string;
    browserDistPath: string;

    /**
     * Extra env vars injected into the SSR Lambda.
     * AWS_LAMBDA_EXEC_WRAPPER, PORT, and NODE_ENV are already set.
     */
    lambdaEnv?: Record<string, string>;
    lambdaMemorySize?: number;

    /** Node.js runtime for the SSR Lambda. Defaults to NODEJS_22_X. */
    lambdaRuntime?: lambda.Runtime;

    /** Timeout for the SSR Lambda. Defaults to 30 seconds. */
    lambdaTimeout?: cdk.Duration;

    /**
     * CPU architecture for the SSR Lambda. Defaults to ARM_64.
     * The Lambda Web Adapter layer ARN is automatically selected to match —
     * override `webAdapterLayerArn` only if you supply a custom-built layer.
     */
    lambdaArchitecture?: lambda.Architecture;

    /**
     * Full ARN of the Lambda Web Adapter layer attached to the SSR function.
     * Defaults to AWS's published adapter layer (account 753240598075,
     * version 25) for the stack's region and `lambdaArchitecture`.
     * Override to pin a different version or use a custom-built layer.
     */
    webAdapterLayerArn?: string;

    /**
     * All three must be provided together to enable a custom domain + HTTPS.
     * Omit all three to serve from the default CloudFront URL only.
     */
    domainName?: string;
    certificate?: acm.ICertificate;
    hostedZone?: route53.IHostedZone;

    /**
     * When true (default), www.<domainName> is added as a CloudFront alias,
     * a Route 53 A record is created for it, and a 301 redirect sends www
     * visitors to the apex domain. Set to false to omit www entirely.
     * Has no effect when domainName is not provided.
     */
    redirectWwwToApex?: boolean;

    /**
     * Additional aliases on the same certificate (e.g. a members subdomain).
     * A Route 53 A record is created for each one. These names must also be
     * present in the ACM certificate's subjectAlternativeNames; the construct
     * does not modify the certificate.
     */
    additionalDomainNames?: string[];

    /**
     * CloudFront cache policy name. Must be unique within the AWS account
     * (CloudFront policies are account-global, not per-stack).
     * Defaults to `${stack.stackName}-${id}-Cache`.
     */
    cachePolicyName?: string;

    /**
     * CloudFront response headers policy name. Same uniqueness constraint.
     * Defaults to `${stack.stackName}-${id}-SecurityHeaders`.
     */
    securityHeadersPolicyName?: string;

    /** Fully-assembled CSP string. Build it in the consuming stack. */
    contentSecurityPolicy: string;

    /**
     * Value for the Permissions-Policy response header.
     * Defaults to 'camera=(), microphone=(), geolocation=()'.
     * Pass an empty string to omit the header entirely.
     */
    permissionsPolicy?: string;

    /**
     * X-Frame-Options header value. Defaults to DENY.
     * Set to SAMEORIGIN if your app embeds itself in an iframe on the same origin.
     */
    frameOption?: cloudfront.HeadersFrameOption;

    /**
     * HTTP methods CloudFront forwards to the SSR Lambda on the default behavior.
     * Defaults to ALLOW_ALL so POST and other verbs reach the Lambda.
     * Restrict to ALLOW_GET_HEAD_OPTIONS if your app never handles mutations
     * at the SSR layer.
     */
    allowedMethods?: cloudfront.AllowedMethods;

    /**
     * When true (default), query strings are included in the CloudFront cache
     * key and forwarded to the Lambda, so /search?q=yoga and /search?q=pilates
     * are cached separately. Set to false only if your app never varies content
     * by query string — this avoids cache fragmentation from UTM parameters and
     * other tracking suffixes.
     */
    cacheQueryStrings?: boolean;

    /**
     * Extra CloudFront behaviors added before the static asset catch-alls.
     * Use this for API paths, e.g. `{ 'api/*': apiBehavior }`.
     *
     * The construct's default `responseHeadersPolicy` (security headers + CSP)
     * and viewer-request `functionAssociations` (x-forwarded-host injection,
     * www→apex redirect) are applied to each entry unless the caller sets
     * those fields explicitly.
     */
    additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>;

    /**
     * Extra file patterns routed to S3 (static behavior) beyond the defaults.
     * Defaults: *.js *.css *.svg *.png *.jpg *.webp *.woff2 site.webmanifest
     */
    additionalStaticPatterns?: string[];

    /**
     * CloudFront price class. Controls which edge locations serve your content.
     * Defaults to PRICE_CLASS_100 (North America and Europe).
     */
    priceClass?: cloudfront.PriceClass;

    /**
     * Removal policy for the S3 assets bucket.
     * Defaults to DESTROY (with autoDeleteObjects) so the bucket is cleaned up
     * when the stack is deleted. Set to RETAIN to preserve assets on deletion.
     */
    bucketRemovalPolicy?: cdk.RemovalPolicy;
}

export class AngularSsrDistribution extends Construct {
    public readonly distribution: cloudfront.Distribution;
    public readonly distributionIdOutput: cdk.CfnOutput;
    public readonly ssrFunction: lambda.Function;
    public readonly assetsBucket: s3.Bucket;
    public readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
    public readonly viewerRequestFunction: cloudfront.Function;

    public get distributionId(): string {
        return this.distribution.distributionId;
    }

    constructor(scope: Construct, id: string, props: AngularSsrDistributionProps) {
        super(scope, id);

        const {
            serverDistPath,
            browserDistPath,
            lambdaEnv = {},
            lambdaMemorySize = 512,
            lambdaRuntime = lambda.Runtime.NODEJS_22_X,
            lambdaTimeout = cdk.Duration.seconds(30),
            lambdaArchitecture = lambda.Architecture.ARM_64,
            webAdapterLayerArn,
            domainName,
            certificate,
            hostedZone,
            redirectWwwToApex = true,
            additionalDomainNames = [],
            cachePolicyName,
            securityHeadersPolicyName,
            contentSecurityPolicy,
            permissionsPolicy = DEFAULT_PERMISSIONS_POLICY,
            frameOption = cloudfront.HeadersFrameOption.DENY,
            allowedMethods = cloudfront.AllowedMethods.ALLOW_ALL,
            cacheQueryStrings = true,
            additionalBehaviors = {},
            additionalStaticPatterns = [],
            priceClass = cloudfront.PriceClass.PRICE_CLASS_100,
            bucketRemovalPolicy = cdk.RemovalPolicy.DESTROY,
        } = props;

        const stack = cdk.Stack.of(this);

        const domainPropsProvided = [domainName, certificate, hostedZone].filter(Boolean).length;
        if (domainPropsProvided > 0 && domainPropsProvided < 3) {
            throw new Error('domainName, certificate, and hostedZone must all be provided together, or all omitted');
        }

        const aliasesEnabled = !!(domainName && certificate && hostedZone);
        const wwwEnabled = aliasesEnabled && redirectWwwToApex;

        const resolvedCachePolicyName = cachePolicyName ?? `${stack.stackName}-${id}-Cache`;
        const resolvedHeadersPolicyName = securityHeadersPolicyName ?? `${stack.stackName}-${id}-SecurityHeaders`;
        const lwaArch = lambdaArchitecture === lambda.Architecture.X86_64 ? 'X86_64' : 'Arm64';
        const resolvedLayerArn = webAdapterLayerArn
            ?? `arn:aws:lambda:${stack.region}:753240598075:layer:LambdaAdapterLayer${lwaArch}:${DEFAULT_WEB_ADAPTER_LAYER_VERSION}`;

        this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
            removalPolicy: bucketRemovalPolicy,
            autoDeleteObjects: bucketRemovalPolicy === cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        this.ssrFunction = new lambda.Function(this, 'SsrFunction', {
            runtime: lambdaRuntime,
            handler: 'run.sh',
            code: lambda.Code.fromAsset(serverDistPath),
            memorySize: lambdaMemorySize,
            timeout: lambdaTimeout,
            architecture: lambdaArchitecture,
            environment: {
                AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
                PORT: '8080',
                NODE_ENV: 'production',
                ...lambdaEnv,
            },
            layers: [
                lambda.LayerVersion.fromLayerVersionArn(
                    this,
                    'WebAdapterLayer',
                    resolvedLayerArn,
                ),
            ],
        });

        const functionUrl = this.ssrFunction.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.AWS_IAM,
        });

        this.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
            this,
            'SecurityHeadersPolicy',
            {
                responseHeadersPolicyName: resolvedHeadersPolicyName,
                securityHeadersBehavior: {
                    strictTransportSecurity: {
                        accessControlMaxAge: cdk.Duration.days(365),
                        includeSubdomains: true,
                        preload: true,
                        override: true,
                    },
                    contentTypeOptions: {override: true},
                    frameOptions: {
                        frameOption,
                        override: true,
                    },
                    referrerPolicy: {
                        referrerPolicy:
                            cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                        override: true,
                    },
                    contentSecurityPolicy: {
                        contentSecurityPolicy,
                        override: true,
                    },
                },
                customHeadersBehavior: permissionsPolicy
                    ? {
                        customHeaders: [
                            {
                                header: 'Permissions-Policy',
                                value: permissionsPolicy,
                                override: true,
                            },
                        ],
                    }
                    : undefined,
            },
        );

        const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket);
        const lambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl);

        const ssrCachePolicy = new cloudfront.CachePolicy(this, 'SsrCachePolicy', {
            cachePolicyName: resolvedCachePolicyName,
            comment: 'SSR HTML cache, driven by origin Cache-Control headers',
            defaultTtl: cdk.Duration.seconds(0),
            minTtl: cdk.Duration.seconds(0),
            maxTtl: cdk.Duration.days(1),
            queryStringBehavior: cacheQueryStrings
                ? cloudfront.CacheQueryStringBehavior.all()
                : cloudfront.CacheQueryStringBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        this.viewerRequestFunction = new cloudfront.Function(this, 'ViewerRequestFunction', {
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            comment: wwwEnabled
                ? `Inject x-forwarded-host; redirect www.${domainName} to apex`
                : 'Inject x-forwarded-host for SSR base URL detection',
            code: wwwEnabled
                ? hostHeaderWithWwwRedirectCode(domainName!)
                : hostHeaderCode(),
        });

        const functionAssociations: cloudfront.FunctionAssociation[] = [{
            function: this.viewerRequestFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }];

        const staticAssetBehavior: cloudfront.BehaviorOptions = {
            origin: s3Origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            responseHeadersPolicy: this.responseHeadersPolicy,
            functionAssociations,
        };

        const staticPatterns = [...DEFAULT_STATIC_PATTERNS, ...additionalStaticPatterns];
        const staticBehaviors = Object.fromEntries(
            staticPatterns.map(p => [p, staticAssetBehavior]),
        );

        const aliasDomains = aliasesEnabled
            ? [domainName!, ...(wwwEnabled ? [`www.${domainName}`] : []), ...additionalDomainNames]
            : undefined;

        const resolvedAdditionalBehaviors = Object.fromEntries(
            Object.entries(additionalBehaviors).map(([pattern, behavior]) => [
                pattern,
                {responseHeadersPolicy: this.responseHeadersPolicy, functionAssociations, ...behavior},
            ]),
        );

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: lambdaOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: ssrCachePolicy,
                originRequestPolicy:
                    cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                allowedMethods,
                responseHeadersPolicy: this.responseHeadersPolicy,
                functionAssociations,
            },
            additionalBehaviors: {
                ...resolvedAdditionalBehaviors,
                ...staticBehaviors,
            },
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            priceClass,
            ...(aliasDomains ? {domainNames: aliasDomains, certificate} : {}),
        });

        // CDK's FunctionUrlOrigin.withOriginAccessControl() only grants
        // lambda:InvokeFunctionUrl. Since AWS's October 2025 change, OAC also
        // needs lambda:InvokeFunction or every request 403s. Remove when CDK fixes this.
        this.ssrFunction.addPermission('InvokeFunctionForCloudFrontOac', {
            principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceArn: `arn:aws:cloudfront::${stack.account}:distribution/${this.distribution.distributionId}`,
        });

        if (aliasesEnabled) {
            const cfTarget = route53.RecordTarget.fromAlias(
                new route53Targets.CloudFrontTarget(this.distribution),
            );

            new route53.ARecord(this, 'ApexAlias', {
                zone: hostedZone!,
                recordName: recordNameWithinZone(hostedZone!, domainName!),
                target: cfTarget,
            });

            if (wwwEnabled) {
                new route53.ARecord(this, 'WwwAlias', {
                    zone: hostedZone!,
                    recordName: recordNameWithinZone(hostedZone!, `www.${domainName}`),
                    target: cfTarget,
                });
            }

            for (const extra of additionalDomainNames) {
                const recordName = recordNameWithinZone(hostedZone!, extra);
                new route53.ARecord(this, `ExtraAlias${extra.replace(/[^a-zA-Z0-9]/g, '')}`, {
                    zone: hostedZone!,
                    recordName,
                    target: cfTarget,
                });
            }
        }

        const browserAssetsSource = s3deploy.Source.asset(browserDistPath);

        new s3deploy.BucketDeployment(this, 'DeployHashedAssets', {
            sources: [browserAssetsSource],
            destinationBucket: this.assetsBucket,
            cacheControl: [
                s3deploy.CacheControl.fromString('public, max-age=31536000, immutable'),
            ],
            exclude: ['*'],
            include: ['*.js', '*.css'],
        });

        new s3deploy.BucketDeployment(this, 'DeployUnhashedAssets', {
            sources: [browserAssetsSource],
            destinationBucket: this.assetsBucket,
            cacheControl: [
                s3deploy.CacheControl.fromString('public, max-age=86400, must-revalidate'),
            ],
            exclude: ['*.js', '*.css'],
        });

        new cdk.CfnOutput(this, 'DistributionDomainName', {
            value: this.distribution.distributionDomainName,
        });

        this.distributionIdOutput = new cdk.CfnOutput(this, 'DistributionId', {
            value: this.distribution.distributionId,
            description: 'CloudFront distribution ID, consumed by the pipeline post-deploy invalidation step',
        });

        if (domainName) {
            new cdk.CfnOutput(this, 'SiteUrl', {value: `https://${domainName}`});
        }
    }
}

/**
 * Compute the record name to use for an `ARecord` whose fully-qualified target
 * is `fqdn`, inside the given hosted zone. Returns `undefined` for the zone's
 * apex, or the prefix portion for a subdomain.
 *
 * Used to support `domainName` values that are *subdomains* of the supplied
 * `hostedZone` (e.g. `domainName = "status.example.com"` with
 * `hostedZone = "example.com"`), as well as the previous behaviour where the
 * `domainName` equalled the zone apex. Throws if the FQDN isn't inside the
 * zone, which would otherwise silently create a record under the wrong name.
 */
function recordNameWithinZone(zone: route53.IHostedZone, fqdn: string): string | undefined {
    const zoneName = zone.zoneName.replace(/\.$/, '').toLowerCase();
    const name = fqdn.replace(/\.$/, '').toLowerCase();
    if (name === zoneName) {
        return undefined;
    }
    if (!name.endsWith(`.${zoneName}`)) {
        throw new Error(
            `Domain "${fqdn}" is not within hosted zone "${zoneName}". `
            + `Pass a zone that contains the domain, or set domainName to a name inside the zone.`,
        );
    }
    return name.slice(0, name.length - zoneName.length - 1);
}
