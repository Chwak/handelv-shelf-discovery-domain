import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface GetCuratedCollectionLambdaConstructProps {
  environment: string;
  regionCode: string;
  curatedCollectionsTable: dynamodb.ITable;
  collectionProductsTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class GetCuratedCollectionLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: GetCuratedCollectionLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'GetCuratedCollectionLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-shelf-disc-get-curated-collection-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Get Curated Collection Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-get-curated-collection-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:Query'],
              resources: [
                props.curatedCollectionsTable.tableArn,
                `${props.curatedCollectionsTable.tableArn}/index/*`,
                props.collectionProductsTable.tableArn,
                `${props.collectionProductsTable.tableArn}/index/*`,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'GetCuratedCollectionLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-domain-get-curated-collection-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/discovery/get-curated-collection/get-curated-collection-lambda.ts');
    this.function = new NodejsFunction(this, 'GetCuratedCollectionFunction', {
      functionName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-get-curated-collection-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: lambdaCodePath,
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
        CURATED_COLLECTIONS_TABLE_NAME: props.curatedCollectionsTable.tableName,
        COLLECTION_PRODUCTS_TABLE_NAME: props.collectionProductsTable.tableName,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Get a curated collection with its products',
    });

    props.curatedCollectionsTable.grantReadData(this.function);
    props.collectionProductsTable.grantReadData(this.function);


    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
