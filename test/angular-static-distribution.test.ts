import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {
    AngularStaticDistribution,
    AngularStaticDistributionProps,
} from '../src/angular-static-distribution';

const DIST = path.join(__dirname, 'fixtures', 'dist');
const APEX = 'example.com';

let failures = 0;

function check(label: string, assertion: () => void): void {
    try {
        assertion();
        console.log(`pass  ${label}`);
    } catch (error) {
        failures++;
        console.log(`FAIL  ${label}`);
        console.log(`        ${(error as Error).message.split('\n')[0]}`);
    }
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

function synth(overrides: Partial<AngularStaticDistributionProps> = {}): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {env: {account: '111111111111', region: 'eu-west-2'}});

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: APEX,
    });
    const certificate = acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        `arn:aws:acm:us-east-1:111111111111:certificate/abc`,
    );

    new AngularStaticDistribution(stack, 'Web', {
        browserDistPath: DIST,
        domainName: APEX,
        certificate,
        hostedZone,
        contentSecurityPolicy: "default-src 'self'",
        redirects: {'/blog/old': '/writing/old'},
        excludeFromUpload: ['redirects.json'],
        ...overrides,
    });

    return Template.fromStack(stack);
}

const template = synth();

check('serves from an S3 origin', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
            Origins: Match.arrayWith([
                Match.objectLike({S3OriginConfig: Match.anyValue()}),
            ]),
        }),
    });
});

// The template still contains Lambdas: BucketDeployment and autoDeleteObjects
// both ship handlers. What must be absent is an origin application, so these
// assert on the origin shape rather than on a Lambda count.
check('provisions no origin function URL', () => {
    template.resourceCountIs('AWS::Lambda::Url', 0);
});

check('has no custom (non-S3) origin', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
            Origins: Match.arrayWith([Match.objectLike({CustomOriginConfig: Match.absent()})]),
        }),
    });
});

check('maps 403 and 404 to the prerendered 404 page with a real 404 status', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
            CustomErrorResponses: Match.arrayWith([
                Match.objectLike({
                    ErrorCode: 403,
                    ResponseCode: 404,
                    ResponsePagePath: '/404/index.html',
                }),
                Match.objectLike({
                    ErrorCode: 404,
                    ResponseCode: 404,
                    ResponsePagePath: '/404/index.html',
                }),
            ]),
        }),
    });
});

check('attaches apex and www aliases', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
            Aliases: Match.arrayWith([APEX, `www.${APEX}`]),
        }),
    });
});

check('associates the viewer request function on the default behaviour', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
            DefaultCacheBehavior: Match.objectLike({
                FunctionAssociations: Match.arrayWith([
                    Match.objectLike({EventType: 'viewer-request'}),
                ]),
            }),
        }),
    });
});

check('bakes the redirect manifest into the function code', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('/blog/old'),
    });
});

check('blocks all public access on the bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
        },
    });
});

check('creates A and AAAA records for apex and www', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 4);
});

check('uploads in three cache-control tiers', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 3);
});

check('exports the distribution id for the pipeline invalidation step', () => {
    const outputs = template.findOutputs('*');
    const found = Object.keys(outputs).some((key) => key.includes('DistributionId'));
    if (!found) {
        throw new Error('no DistributionId output found');
    }
});

const noDomain = synth({domainName: undefined, certificate: undefined, hostedZone: undefined});

check('omits aliases and DNS records when no domain is configured', () => {
    noDomain.resourceCountIs('AWS::Route53::RecordSet', 0);
});

check('still serves the site when no domain is configured', () => {
    noDomain.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({Aliases: Match.absent()}),
    });
});

const noWww = synth({redirectWwwToApex: false});

check('drops www entirely when redirectWwwToApex is false', () => {
    noWww.resourceCountIs('AWS::Route53::RecordSet', 2);
});

throws('rejects a partial domain configuration', () => synth({certificate: undefined}));

console.log('');
if (failures > 0) {
    console.log(`${failures} failing`);
    process.exit(1);
}
console.log('all static distribution checks passed');
