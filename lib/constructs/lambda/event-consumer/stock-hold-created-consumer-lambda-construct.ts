import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

export interface StockHoldCreatedConsumerLambdaConstructProps {
  environment: string;
  regionCode: string;
  eventBus: events.IEventBus;
  shelfItemsTable: dynamodb.ITable;
  idempotencyTable: dynamodb.ITable;
  removalPolicy?: RemovalPolicy;
}

export class StockHoldCreatedConsumerLambdaConstruct extends Construct {
  public readonly function: lambda.IFunction;
  public readonly queue: sqs.IQueue;
  public readonly deadLetterQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: StockHoldCreatedConsumerLambdaConstructProps) {
    super(scope, id);

    // Dead Letter Queue
    this.deadLetterQueue = new sqs.Queue(this, 'StockHoldCreatedConsumerDLQ', {
      queueName: `${props.environment}-${props.regionCode}-shelf-discovery-stock-hold-created-consumer-dlq`,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });

    // Main queue for stock.hold.created events
    this.queue = new sqs.Queue(this, 'StockHoldCreatedConsumerQueue', {
      queueName: `${props.environment}-${props.regionCode}-shelf-discovery-stock-hold-created-consumer-queue`,
      visibilityTimeout: Duration.seconds(180),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });

    // Lambda function to process stock.hold.created events
    this.function = new lambdaNodeJs.NodejsFunction(this, 'StockHoldCreatedConsumerFunction', {
      functionName: `${props.environment}-${props.regionCode}-shelf-discovery-stock-hold-created-consumer`,
      entry: `${__dirname}/../../../functions/lambda/event-consumer/stock-hold-created-consumer-lambda.ts`,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        SHELF_ITEMS_TABLE_NAME: props.shelfItemsTable.tableName,
        IDEMPOTENCY_TABLE_NAME: props.idempotencyTable.tableName,
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: false,
      },
    });

    // CloudWatch Log Group
    new logs.LogGroup(this, 'StockHoldCreatedConsumerLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-shelf-discovery-stock-hold-created-consumer`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });

    // Grant permissions
    props.shelfItemsTable.grantReadWriteData(this.function);
    props.idempotencyTable.grantReadWriteData(this.function);

    // Connect to SQS
    this.function.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        maxBatchingWindow: Duration.seconds(5),
      })
    );

    // EventBridge rule: route stock.hold.created.v1 to this queue
    const stockHoldCreatedRule = new events.Rule(this, 'StockHoldCreatedRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['hand-made.order-domain'],
        detailType: ['stock.hold.created.v1'],
      },
      description: 'Route stock.hold.created.v1 events to Shelf-Discovery Domain for inventory reservation',
    });

    stockHoldCreatedRule.addTarget(new targets.SqsQueue(this.queue));
  }
}
