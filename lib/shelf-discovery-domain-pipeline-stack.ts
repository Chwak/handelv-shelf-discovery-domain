/**
 * Template for domain pipeline stacks — copy pattern per domain (class names differ).
 * All resources deploy to DEV_BACKEND_ACCOUNT_ID (741429964649).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { DEV_BACKEND_ACCOUNT_ID } from './utils/deployment-env';
import {
  addDevOnlyDeployWave,
  devOnlyCdkAssumeRoleStatement,
} from './utils/domain-pipeline-dev-only';

export interface ShelfDiscoveryShelfDiscoveryDomainPipelineStackProps extends cdk.StackProps {
  domain: string;
  githubConnectionArn: string;
}

export class ShelfDiscoveryDomainPipelineStack extends cdk.Stack {
  public readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ShelfDiscoveryShelfDiscoveryDomainPipelineStackProps) {
    super(scope, id, props);

    const { domain, githubConnectionArn } = props;

    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `handelv-${domain}-artifacts-${DEV_BACKEND_ACCOUNT_ID}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(7),
          expiration: cdk.Duration.days(90),
        },
      ],
      enforceSSL: true,
    });

    const source = pipelines.CodePipelineSource.connection(
      `Chwak/handelv-${domain}`,
      'main',
      {
        connectionArn: githubConnectionArn,
        triggerOnPush: true,
      }
    );

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: `Handelv-${this.pascalCase(domain)}`,
      artifactBucket: this.artifactBucket,
      publishAssetsInParallel: false,
      selfMutation: false,

      synth: new pipelines.ShellStep('Synth', {
        input: source,
        commands: [
          'npm ci --no-audit --no-fund',
          'npm run build',
          'npx cdk synth',
        ],
        primaryOutputDirectory: 'cdk.out',
        env: {
          SHELL: '/bin/bash',
        },
      }),

      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: cdk.aws_codebuild.ComputeType.SMALL,
          environmentVariables: {
            PIPELINE_EXECUTION_ID: {
              value: cdk.aws_codepipeline.GlobalVariables.executionId,
            },
            DOMAIN: {
              value: domain,
            },
            BUILD_TIMESTAMP: {
              value: new Date().toISOString(),
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: new logs.LogGroup(this, 'LogGroup', {
              logGroupName: `/aws/codebuild/handelv-${domain}-pipeline`,
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          },
        },
        timeout: cdk.Duration.minutes(30),
        rolePolicy: [devOnlyCdkAssumeRoleStatement(DEV_BACKEND_ACCOUNT_ID)],
      },
    });

    addDevOnlyDeployWave(pipeline, {
      domain,
      pascalCaseDomain: this.pascalCase(domain),
    });

    pipeline.buildPipeline();

    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipeline.pipelineName,
      exportName: `${domain}-pipeline-name`,
      description: `Pipeline name for ${domain}`,
    });

    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipeline.pipeline.pipelineArn,
      exportName: `${domain}-pipeline-arn`,
      description: `Pipeline ARN for ${domain}`,
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      exportName: `${domain}-artifact-bucket`,
      description: `Artifact bucket for ${domain}`,
    });

    new cdk.CfnOutput(this, 'DeployAccountId', {
      value: DEV_BACKEND_ACCOUNT_ID,
      description: 'Hardcoded dev account for all pipeline deploys',
    });
  }

  private pascalCase(value: string): string {
    return value
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }
}
