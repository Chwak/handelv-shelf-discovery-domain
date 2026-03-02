import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface UpdateSearchIndexLambdaConstructProps {
  environment: string;
  regionCode: string;
  searchDocumentsTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class UpdateSearchIndexLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: UpdateSearchIndexLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'UpdateSearchIndexLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-shelf-disc-update-search-index-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Update Search Index Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-update-search-index-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
              resources: [props.searchDocumentsTable.tableArn],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'UpdateSearchIndexLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-update-search-index-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/discovery/update-search-index');
    this.function = new lambda.Function(this, 'UpdateSearchIndexFunction', {
      functionName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-update-search-index-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'update-search-index-lambda.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      role,
      timeout: cdk.Duration.seconds(60), // Longer timeout for indexing operations
      memorySize: 512, // More memory for processing
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      environment: {
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
        SEARCH_DOCUMENTS_TABLE_NAME: props.searchDocumentsTable.tableName,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Update search index when products are created, updated, or deleted',
    });

    props.searchDocumentsTable.grantReadWriteData(this.function);


    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
