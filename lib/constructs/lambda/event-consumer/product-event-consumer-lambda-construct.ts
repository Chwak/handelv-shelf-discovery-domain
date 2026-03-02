import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

export interface ProductEventConsumerLambdaConstructProps {
  environment: string;
  regionCode: string;
  eventBus: events.IEventBus;
  shelfItemsTable: dynamodb.ITable;
  soldOutItemsTable: dynamodb.ITable;
  idempotencyTable: dynamodb.ITable;
  schemaRegistryName: string;
  removalPolicy: RemovalPolicy;
}

export class ProductEventConsumerLambdaConstruct extends Construct {
  public readonly function: lambda.IFunction;
  public readonly queue: sqs.IQueue;
  public readonly deadLetterQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: ProductEventConsumerLambdaConstructProps) {
    super(scope, id);

    // Dead Letter Queue for failed event processing
    this.deadLetterQueue = new sqs.Queue(this, 'ProductEventConsumerDLQ', {
      queueName: `${props.environment}-${props.regionCode}-discovery-product-event-consumer-dlq`,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy,
    });

    // Main queue for product events from EventBridge
    this.queue = new sqs.Queue(this, 'ProductEventConsumerQueue', {
      queueName: `${props.environment}-${props.regionCode}-discovery-product-event-consumer-queue`,
      visibilityTimeout: Duration.seconds(180), // 3x Lambda timeout
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3, // Retry 3 times before sending to DLQ
      },
      removalPolicy: props.removalPolicy,
    });

    // Explicit log group
    const logGroup = new logs.LogGroup(this, 'ProductEventConsumerLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-ProductEventConsumer`,
      retention: props.removalPolicy === RemovalPolicy.RETAIN ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy,
    });

    // Lambda function to process product events
    this.function = new lambdaNodeJs.NodejsFunction(
      this,
      `${props.environment}-${props.regionCode}-ProductEventConsumer`,
      {
        entry: __dirname + '/../../../functions/lambda/event-consumer/product-event-consumer-lambda.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.seconds(60),
        memorySize: 512,
        logGroup: logGroup,
        environment: {
          SHELF_ITEMS_TABLE_NAME: props.shelfItemsTable.tableName,
          SOLD_OUT_ITEMS_TABLE_NAME: props.soldOutItemsTable.tableName,
          IDEMPOTENCY_TABLE_NAME: props.idempotencyTable.tableName,
          SCHEMA_REGISTRY_NAME: props.schemaRegistryName,
          ENVIRONMENT: props.environment,
          REGION_CODE: props.regionCode,
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: false,
          sourceMap: false,
        },
      }
    );

    // Grant permissions
    props.shelfItemsTable.grantReadWriteData(this.function);
    props.soldOutItemsTable.grantReadWriteData(this.function);
    props.idempotencyTable.grantReadWriteData(this.function);

    // Grant Glue Schema Registry read permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'glue:GetSchemaVersion',
          'glue:GetSchemaByDefinition',
        ],
        resources: [
          `arn:aws:glue:*:*:registry/${props.schemaRegistryName}`,
          `arn:aws:glue:*:*:schema/${props.schemaRegistryName}/*`,
        ],
      })
    );

    // Connect Lambda to SQS queue
    this.function.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        maxBatchingWindow: Duration.seconds(5),
      })
    );

    // EventBridge rules to route product events to SQS
    // Rule 1: product.shelf.item.published.v1
    const publishedRule = new events.Rule(this, 'ProductPublishedRule', {
      eventBus: props.eventBus,
      ruleName: `${props.environment}-${props.regionCode}-discovery-product-published`,
      description: 'Route product published events to Discovery domain',
      eventPattern: {
        detailType: ['product.shelf.item.published.v1'],
        source: ['hand-made.product-domain'],
      },
    });
    publishedRule.addTarget(new targets.SqsQueue(this.queue));

    // Rule 2: product.shelf.item.updated.v1
    const updatedRule = new events.Rule(this, 'ProductUpdatedRule', {
      eventBus: props.eventBus,
      ruleName: `${props.environment}-${props.regionCode}-discovery-product-updated`,
      description: 'Route product updated events to Discovery domain',
      eventPattern: {
        detailType: ['product.shelf.item.updated.v1'],
        source: ['hand-made.product-domain'],
      },
    });
    updatedRule.addTarget(new targets.SqsQueue(this.queue));

    // Rule 3: product.shelf.item.removed.v1
    const removedRule = new events.Rule(this, 'ProductRemovedRule', {
      eventBus: props.eventBus,
      ruleName: `${props.environment}-${props.regionCode}-discovery-product-removed`,
      description: 'Route product removed events to Discovery domain',
      eventPattern: {
        detailType: ['product.shelf.item.removed.v1'],
        source: ['hand-made.product-domain'],
      },
    });
    removedRule.addTarget(new targets.SqsQueue(this.queue));
  }
}
