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

export interface AngularSsrDistributionProps {
    serverDistPath: string;
    browserDistPath: string;

    /**
     * Extra env vars injected into the SSR Lambda.
     * AWS_LAMBDA_EXEC_WRAPPER, PORT, and NODE_ENV are already set.
     */
    lambdaEnv?: Record<string, string>;
    lambdaMemorySize?: number;

    /**
     * Full ARN of the Lambda Web Adapter layer attached to the SSR function.
     * Defaults to AWS's published Arm64 adapter layer (account 753240598075,
     * version 25) in the stack's region. Override to pin a different version
     * or to use a custom-built layer.
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
     * Defaults to `PRICE_CLASS_100` (North America and Europe).
     */
    priceClass?: cloudfront.PriceClass;
}

export class AngularSsrDistribution extends Construct {
    public readonly distribution: cloudfront.Distribution;
    public readonly distributionIdOutput: cdk.CfnOutput;
    public readonly ssrFunction: lambda.Function;
    public readonly assetsBucket: s3.Bucket;
    public readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
    public readonly viewerRequestFunction: cloudfront.Function;

    constructor(scope: Construct, id: string, props: AngularSsrDistributionProps) {
        super(scope, id);

        const {
            serverDistPath,
            browserDistPath,
            lambdaEnv = {},
            lambdaMemorySize = 512,
            webAdapterLayerArn,
            domainName,
            certificate,
            hostedZone,
            additionalDomainNames = [],
            cachePolicyName,
            securityHeadersPolicyName,
            contentSecurityPolicy,
            additionalBehaviors = {},
            additionalStaticPatterns = [],
            priceClass = cloudfront.PriceClass.PRICE_CLASS_100,
        } = props;

        const stack = cdk.Stack.of(this);

        const domainPropsProvided = [domainName, certificate, hostedZone].filter(Boolean).length;
        if (domainPropsProvided > 0 && domainPropsProvided < 3) {
            throw new Error('domainName, certificate, and hostedZone must all be provided together, or all omitted');
        }

        const aliasesEnabled = !!(domainName && certificate && hostedZone);

        const resolvedCachePolicyName = cachePolicyName ?? `${stack.stackName}-${id}-Cache`;
        const resolvedHeadersPolicyName = securityHeadersPolicyName ?? `${stack.stackName}-${id}-SecurityHeaders`;
        const resolvedLayerArn = webAdapterLayerArn
            ?? `arn:aws:lambda:${stack.region}:753240598075:layer:LambdaAdapterLayerArm64:${DEFAULT_WEB_ADAPTER_LAYER_VERSION}`;

        this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        this.ssrFunction = new lambda.Function(this, 'SsrFunction', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'run.sh',
            code: lambda.Code.fromAsset(serverDistPath),
            memorySize: lambdaMemorySize,
            timeout: cdk.Duration.seconds(30),
            architecture: lambda.Architecture.ARM_64,
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
                        frameOption: cloudfront.HeadersFrameOption.DENY,
                        override: true,
                    },
                    referrerPolicy: {
                        referrerPolicy:
                            cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                        override: true,
                    },
                    xssProtection: {
                        protection: true,
                        modeBlock: true,
                        override: true,
                    },
                    contentSecurityPolicy: {
                        contentSecurityPolicy,
                        override: true,
                    },
                },
                customHeadersBehavior: {
                    customHeaders: [
                        {
                            header: 'Permissions-Policy',
                            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
                            override: true,
                        },
                    ],
                },
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
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        this.viewerRequestFunction = new cloudfront.Function(this, 'ViewerRequestFunction', {
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            comment: aliasesEnabled
                ? `Inject x-forwarded-host; redirect www.${domainName} to apex`
                : 'Inject x-forwarded-host for SSR base URL detection',
            code: aliasesEnabled
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
            ? [domainName!, `www.${domainName}`, ...additionalDomainNames]
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
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
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
            new route53.ARecord(this, 'ApexAlias', {
                zone: hostedZone!,
                target: route53.RecordTarget.fromAlias(
                    new route53Targets.CloudFrontTarget(this.distribution),
                ),
            });

            new route53.ARecord(this, 'WwwAlias', {
                zone: hostedZone!,
                recordName: 'www',
                target: route53.RecordTarget.fromAlias(
                    new route53Targets.CloudFrontTarget(this.distribution),
                ),
            });

            for (const extra of additionalDomainNames) {
                const recordName = domainName && extra.endsWith(`.${domainName}`)
                    ? extra.slice(0, -1 - domainName.length)
                    : extra;
                new route53.ARecord(this, `ExtraAlias${recordName}`, {
                    zone: hostedZone!,
                    recordName,
                    target: route53.RecordTarget.fromAlias(
                        new route53Targets.CloudFrontTarget(this.distribution),
                    ),
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
