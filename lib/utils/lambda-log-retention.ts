import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Utility to add CloudWatch Log retention to Lambda functions via LogRetention construct.
 *
 * Uses an explicit LogRetention role (no CDK auto-generated role). The custom role MUST have
 * logs:CreateLogGroup, logs:PutRetentionPolicy, logs:DescribeLogGroups, and (for DESTROY)
 * logs:DeleteLogGroup / logs:DescribeLogStreams / logs:DeleteLogStream.
 *
 * Cost Optimization: Set retention to 1 day to reduce CloudWatch Logs costs by ~95%
 * Logs are exported to S3 for long-term storage (90% cheaper)
 */
export function addLogRetention(
  scope: Construct,
  lambdaFunction: lambda.Function,
  retentionDays: logs.RetentionDays = logs.RetentionDays.ONE_WEEK,
  role: iam.IRole
): logs.LogRetention {
  const logGroupName = `/aws/lambda/${lambdaFunction.functionName}`;
  const logRetention = new logs.LogRetention(scope, `${lambdaFunction.node.id}LogRetention`, {
    logGroupName,
    retention: retentionDays,
    role,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  lambdaFunction.node.addDependency(logRetention);
  return logRetention;
}

export class LogRetentionManager {
  static setLogRetention(
    scope: Construct,
    lambdaFunction: lambda.Function | lambda.IFunction,
    removalPolicy: cdk.RemovalPolicy
  ): logs.LogRetention {
    const retention = removalPolicy === cdk.RemovalPolicy.RETAIN
      ? logs.RetentionDays.ONE_MONTH
      : logs.RetentionDays.ONE_WEEK;

    const role = new iam.Role(scope, `${lambdaFunction.node.id}LogRetentionRole`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:PutRetentionPolicy',
          'logs:DescribeLogGroups',
          'logs:DeleteLogGroup',
          'logs:DescribeLogStreams',
          'logs:DeleteLogStream',
        ],
        resources: [
          `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${lambdaFunction.functionName}*`,
        ],
      })
    );

    return addLogRetention(scope, lambdaFunction as lambda.Function, retention, role);
  }
}
