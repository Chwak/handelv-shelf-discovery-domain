import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodeJs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface ProductShelfItemUpdatedConsumerLambdaConstructProps {
  environment: string;
  regionCode: string;
  outboxTable: dynamodb.ITable;
  eventBus: events.IEventBus;
  removalPolicy: cdk.RemovalPolicy;
}

export class ProductShelfItemUpdatedConsumerLambdaConstruct extends Construct {
  public function: lambdaNodeJs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ProductShelfItemUpdatedConsumerLambdaConstructProps) {
    super(scope, id);

    const { environment, regionCode, outboxTable, eventBus, removalPolicy } = props;

    // Create DLQ for failed messages
    const dlq = new sqs.Queue(this, "ProductShelfItemUpdatedConsumerDLQ", {
      queueName: `${environment}-${regionCode}-product-shelf-updated-consumer-dlq`,
      removalPolicy,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    // Create SQS queue for product.shelf.item.updated events
    const queue = new sqs.Queue(this, "ProductShelfItemUpdatedConsumerQueue", {
      queueName: `${environment}-${regionCode}-product-shelf-updated-consumer-queue`,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(3),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: dlq,
      },
      removalPolicy,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    // Create Lambda function
    this.function = new lambdaNodeJs.NodejsFunction(this, "ProductShelfItemUpdatedConsumerFunction", {
      functionName: `${environment}-${regionCode}-discovery-product-shelf-updated-consumer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: `${__dirname}/../../../functions/lambda/event-consumer/product-shelf-item-updated-consumer-lambda.ts`,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: false,
      },
      environment: {
        SEARCH_INDEX_TABLE_NAME: `${environment}-${regionCode}-discovery-search-index`,
        IDEMPOTENCY_TABLE_NAME: `${environment}-${regionCode}-discovery-product-shelf-updated-idempotency`,
        OUTBOX_TABLE_NAME: outboxTable.tableName,
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
    });

    // Create search index table
    const searchIndexTable = new dynamodb.Table(this, "SearchIndexTable", {
      tableName: `${environment}-${regionCode}-discovery-search-index`,
      partitionKey: { name: "searchIndexId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Add GSI for product lookup
    searchIndexTable.addGlobalSecondaryIndex({
      indexName: "ProductIdIndex",
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Add GSI for maker lookup
    searchIndexTable.addGlobalSecondaryIndex({
      indexName: "MakerIdIndex",
      partitionKey: { name: "makerId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Create idempotency table
    const idempotencyTable = new dynamodb.Table(this, "ProductShelfUpdatedIdempotencyTable", {
      tableName: `${environment}-${regionCode}-discovery-product-shelf-updated-idempotency`,
      partitionKey: { name: "shelfItemId", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Grant permissions
    searchIndexTable.grantWriteData(this.function);
    idempotencyTable.grantReadWriteData(this.function);
    outboxTable.grantReadWriteData(this.function);
    queue.grantConsumeMessages(this.function);

    // Create EventBridge rule to route product.shelf.item.updated.v1 events to SQS
    const rule = new events.Rule(this, "ProductShelfItemUpdatedRule", {
      eventBus,
      eventPattern: {
        source: ["hand-made.product-domain"],
        detailType: ["product.shelf.item.updated.v1"],
      },
      targets: [new targets.SqsQueue(queue)],
    });

    // Create EventSource mapping from SQS to Lambda
    this.function.addEventSourceMapping("ProductShelfUpdatedEventSourceMapping", {
      eventSourceArn: queue.queueArn,
      batchSize: 10,
      reportBatchItemFailures: true,
    });

    // Create CloudWatch LogGroup
    new logs.LogGroup(this, "ProductShelfUpdatedConsumerLogGroup", {
      logGroupName: `/aws/lambda/${this.function.functionName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });
  }
}
