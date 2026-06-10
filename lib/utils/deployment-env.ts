/**
 * Workspace deployment policy: every CDK stack (workload and pipeline) targets the dev backend account.
 */

import * as cdk from 'aws-cdk-lib';

export const DEPLOYMENT_ENVIRONMENT = 'dev' as const;
export type DeploymentEnvironment = typeof DEPLOYMENT_ENVIRONMENT;

export const DEPLOYMENT_REGION_CODE = 'use1' as const;
export const DEPLOYMENT_AWS_REGION = 'us-east-1' as const;

/** Hardcoded deploy account for all CDK stacks in this workspace. */
export const DEV_BACKEND_ACCOUNT_ID = '741429964649' as const;

/** Alias — use for every stack `env.account`. */
export const CDK_DEPLOY_ACCOUNT_ID = DEV_BACKEND_ACCOUNT_ID;

/** CodeStar connection lives in org management; not a CDK deploy target. */
export const CODESTAR_CONNECTION_ACCOUNT_ID = '567608120268' as const;

export const GITHUB_CONNECTION_ARN =
  'arn:aws:codeconnections:us-east-1:567608120268:connection/6b01e09c-3e85-4c07-8ca7-e4313f3f1a45';

/** Accounts that must never appear as stack env.account or CDK_TARGET_ACCOUNT_ID. */
export const FORBIDDEN_DEPLOY_ACCOUNT_IDS = [
  '021657748325', // prod backend
  '329177708881', // mimic
  '567608120268', // management
  '976589843822', // prod frontend
] as const;

const FORBIDDEN_ENVIRONMENTS = new Set(['mimic', 'prod', 'production', 'staging']);

function normalizeEnvironment(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function assertExplicitDeployAccount(candidate: string | undefined | null, source: string): void {
  const id = candidate?.trim();
  if (!id) {
    return;
  }
  if ((FORBIDDEN_DEPLOY_ACCOUNT_IDS as readonly string[]).includes(id)) {
    throw new Error(
      `${source} is ${id}, which is a FORBIDDEN deploy account (prod/mimic/management). ` +
        `Only the dev backend account ${DEV_BACKEND_ACCOUNT_ID} may be targeted.`,
    );
  }
  if (id !== DEV_BACKEND_ACCOUNT_ID) {
    throw new Error(
      `${source} must be ${DEV_BACKEND_ACCOUNT_ID} (got ${id}). ` +
        'All CDK stacks must use the hardcoded dev account in this workspace.',
    );
  }
}

export function assertDeployAccountEnvVars(): void {
  assertExplicitDeployAccount(process.env.CDK_TARGET_ACCOUNT_ID, 'CDK_TARGET_ACCOUNT_ID');
  // CDK_DEFAULT_ACCOUNT is resolved by the CDK CLI from the active AWS credentials;
  // AWS_ACCOUNT_ID is set by our deploy scripts. Asserting both fails synth fast when
  // a misconfigured profile points at prod/mimic/management instead of failing later
  // (or worse, succeeding) at deploy time.
  assertExplicitDeployAccount(process.env.CDK_DEFAULT_ACCOUNT, 'CDK_DEFAULT_ACCOUNT');
  assertExplicitDeployAccount(process.env.AWS_ACCOUNT_ID, 'AWS_ACCOUNT_ID');
}

export function resolveDeploymentEnvironment(requested?: string | null): DeploymentEnvironment {
  const fromEnv = normalizeEnvironment(process.env.ENVIRONMENT);
  const fromContext = normalizeEnvironment(requested);
  const chosen = fromContext ?? fromEnv ?? DEPLOYMENT_ENVIRONMENT;

  if (FORBIDDEN_ENVIRONMENTS.has(chosen) || chosen !== DEPLOYMENT_ENVIRONMENT) {
    throw new Error(
      `Deployment environment must be "${DEPLOYMENT_ENVIRONMENT}" (got "${chosen}"). ` +
        'mimic/prod/staging deploys are disabled in this workspace.',
    );
  }

  if (fromEnv && fromEnv !== DEPLOYMENT_ENVIRONMENT) {
    throw new Error(
      `ENVIRONMENT=${process.env.ENVIRONMENT} is not allowed; only "${DEPLOYMENT_ENVIRONMENT}" is permitted.`,
    );
  }

  return DEPLOYMENT_ENVIRONMENT;
}

export function resolveDeploymentRegionCode(
  requested?: string | null,
  awsRegion?: string,
): typeof DEPLOYMENT_REGION_CODE {
  const fromEnv = process.env.REGION_CODE?.trim();
  const fromContext = requested?.trim();
  const chosen = fromContext || fromEnv || DEPLOYMENT_REGION_CODE;
  if (chosen !== DEPLOYMENT_REGION_CODE) {
    throw new Error(
      `Region code must be "${DEPLOYMENT_REGION_CODE}" (got "${chosen}").`,
    );
  }
  const region = awsRegion?.trim() || process.env.AWS_REGION?.trim() || process.env.CDK_DEFAULT_REGION?.trim();
  if (region && region !== DEPLOYMENT_AWS_REGION) {
    throw new Error(
      `AWS region must be ${DEPLOYMENT_AWS_REGION} for dev deploys (got "${region}").`,
    );
  }
  return DEPLOYMENT_REGION_CODE;
}

export function resolveDeploymentAccountId(): typeof DEV_BACKEND_ACCOUNT_ID {
  assertDeployAccountEnvVars();
  return DEV_BACKEND_ACCOUNT_ID;
}

export function resolveCdkStackEnv(): {
  account: typeof DEV_BACKEND_ACCOUNT_ID;
  region: typeof DEPLOYMENT_AWS_REGION;
} {
  assertDeployAccountEnvVars();
  return {
    account: DEV_BACKEND_ACCOUNT_ID,
    region: DEPLOYMENT_AWS_REGION,
  };
}

/** @deprecated Use resolveCdkStackEnv */
export const resolveCdkWorkloadEnv = resolveCdkStackEnv;

export function workloadDeployShellExports(): string {
  return [
    `ENVIRONMENT=${DEPLOYMENT_ENVIRONMENT}`,
    `REGION_CODE=${DEPLOYMENT_REGION_CODE}`,
    `AWS_REGION=${DEPLOYMENT_AWS_REGION}`,
    `CDK_DEFAULT_REGION=${DEPLOYMENT_AWS_REGION}`,
    `CDK_DEFAULT_ACCOUNT=${DEV_BACKEND_ACCOUNT_ID}`,
    `AWS_ACCOUNT_ID=${DEV_BACKEND_ACCOUNT_ID}`,
  ].join(' ');
}

export interface CdkDeployContext {
  environment: DeploymentEnvironment;
  regionCode: typeof DEPLOYMENT_REGION_CODE;
  account: typeof DEV_BACKEND_ACCOUNT_ID;
  region: typeof DEPLOYMENT_AWS_REGION;
}

/** Entry point for all CDK apps (domain stacks and pipeline stacks). */
export function initCdkAppDeploy(app: cdk.App): CdkDeployContext {
  const environment = resolveDeploymentEnvironment(
    app.node.tryGetContext('environment') as string | undefined,
  );
  const regionCode = resolveDeploymentRegionCode(
    app.node.tryGetContext('regionCode') as string | undefined,
  );
  assertExplicitDeployAccount(
    app.node.tryGetContext('account') as string | undefined,
    'CDK context account',
  );
  assertDeployAccountEnvVars();

  return {
    environment,
    regionCode,
    account: DEV_BACKEND_ACCOUNT_ID,
    region: DEPLOYMENT_AWS_REGION,
  };
}

/** @deprecated Use initCdkAppDeploy */
export const initWorkloadDeploy = initCdkAppDeploy;
