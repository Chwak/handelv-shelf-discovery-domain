import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface GetFeedLambdaConstructProps {
  environment: string;
  regionCode: string;
  shelfItemsTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class GetFeedLambdaConstruct extends Construct {
  public readonly function: lambda.IFunction;

  constructor(scope: Construct, id: string, props: GetFeedLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'GetFeedLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-shelf-disc-get-feed-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Get Feed Lambda',
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-get-feed-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem'],
              resources: [
                props.shelfItemsTable.tableArn,
                `${props.shelfItemsTable.tableArn}/index/*`,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'GetFeedLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-get-feed-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const entryPath = path.join(
      __dirname,
      '../../../../functions/lambda/discovery/get-feed/get-feed-lambda.ts',
    );

    this.function = new lambdaNodeJs.NodejsFunction(this, 'GetFeedFunction', {
      functionName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-get-feed-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: entryPath,
      handler: 'handler',
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        SHELF_ITEMS_TABLE_NAME: props.shelfItemsTable.tableName,
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Serve paginated feed of active shelf items to collectors',
    });

    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
