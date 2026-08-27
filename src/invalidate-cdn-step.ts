import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';

/**
 * Structural type shared by every distribution construct in this package, so
 * the step works with either without importing them and without instanceof.
 */
export interface InvalidatableDistribution {
    readonly distributionIdOutput: cdk.CfnOutput;
}

/**
 * Post-deploy step that invalidates the whole distribution.
 *
 * Blunt on purpose: fingerprinted assets are immutable and never need it, and
 * everything else is HTML small enough that a full invalidation costs nothing
 * against the monthly free allowance.
 */
export function invalidateCdnStep(
    source: InvalidatableDistribution | cdk.CfnOutput,
): pipelines.CodeBuildStep {
    const distributionIdOutput = source instanceof cdk.CfnOutput
        ? source
        : source.distributionIdOutput;

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
