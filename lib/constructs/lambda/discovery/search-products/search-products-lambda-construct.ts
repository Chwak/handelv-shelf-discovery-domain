import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface SearchProductsLambdaConstructProps {
  environment: string;
  regionCode: string;
  shelfItemsTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class SearchProductsLambdaConstruct extends Construct {
  public readonly function: lambda.IFunction;

  constructor(scope: Construct, id: string, props: SearchProductsLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'SearchProductsLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-shelf-disc-search-products-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Search Products Lambda (DynamoDB only, no OpenSearch)',
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-search-products-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:GetItem'],
              resources: [
                props.shelfItemsTable.tableArn,
                `${props.shelfItemsTable.tableArn}/index/*`,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'SearchProductsLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-search-products-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const entryPath = path.join(
      __dirname,
      '../../../../functions/lambda/discovery/search-products/search-products-lambda.ts',
    );
    this.function = new lambdaNodeJs.NodejsFunction(this, 'SearchProductsFunction', {
      functionName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-search-products-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: entryPath,
      handler: 'handler',
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: false,
        target: 'node22',
      },
      environment: {
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
        SHELF_ITEMS_TABLE_NAME: props.shelfItemsTable.tableName,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Search products (DynamoDB filter/query, no OpenSearch)',
    });

    props.shelfItemsTable.grantReadData(this.function);


    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
