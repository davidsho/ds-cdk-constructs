import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';

export function invalidateCdnStep(distributionIdOutput: cdk.CfnOutput): pipelines.CodeBuildStep {
    return new pipelines.CodeBuildStep('InvalidateCdn', {
        commands: [
            'aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"',
        ],
        envFromCfnOutputs: {
            DISTRIBUTION_ID: distributionIdOutput,
        },
        rolePolicyStatements: [
            new iam.PolicyStatement({
                actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
                resources: ['*'],
            }),
        ],
    });
}
