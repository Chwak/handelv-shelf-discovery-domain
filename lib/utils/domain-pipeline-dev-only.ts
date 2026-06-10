import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';
import {
  DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_REGION_CODE,
  DEV_BACKEND_ACCOUNT_ID,
  workloadDeployShellExports,
} from './deployment-env';

export interface DevOnlyPipelineWaveOptions {
  domain: string;
  pascalCaseDomain: string;
}

export function devOnlyCdkAssumeRoleStatement(devAccountId: string = DEV_BACKEND_ACCOUNT_ID): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['sts:AssumeRole'],
    resources: [
      `arn:aws:iam::${devAccountId}:role/cdk-hnb659fds-deploy-role-*`,
      `arn:aws:iam::${devAccountId}:role/cdk-hnb659fds-file-publishing-role-*`,
      `arn:aws:iam::${devAccountId}:role/cdk-hnbkdev-deploy-role-*`,
      `arn:aws:iam::${devAccountId}:role/cdk-hnbkdev-file-publishing-role-*`,
    ],
  });
}

/** Single deploy wave: account 741429964649 only (no mimic/prod). */
export function addDevOnlyDeployWave(
  pipeline: pipelines.CodePipeline,
  options: DevOnlyPipelineWaveOptions,
): void {
  const { domain, pascalCaseDomain } = options;
  const deployEnv = workloadDeployShellExports();
  pipeline.addWave('DeployToDev', {
    post: [
      new pipelines.CodeBuildStep(`Deploy${pascalCaseDomain}Dev`, {
        commands: [
          `echo "=== Deploying ${domain} to account ${DEV_BACKEND_ACCOUNT_ID} (${DEPLOYMENT_ENVIRONMENT}) ==="`,
          `export ${deployEnv}`,
          'npm ci --no-audit --no-fund',
          'npm run build',
          `npx cdk deploy "${DEPLOYMENT_ENVIRONMENT}-${DEPLOYMENT_REGION_CODE}-hand-made-*-stack" --require-approval never`,
          `echo "✓ ${domain} deployed to ${DEV_BACKEND_ACCOUNT_ID}"`,
        ],
      }),
    ],
  });
}
