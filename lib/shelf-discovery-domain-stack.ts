import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DomainStackProps } from "./domain-stack-props";
import { DiscoveryAppSyncConstruct } from "./constructs/appsync/discovery-appsync/discovery-appsync-construct";
import { DiscoveryTablesConstruct } from "./constructs/dynamodb/discovery-tables/discovery-tables-construct";
import { OutboxTableConstruct } from "./constructs/dynamodb/outbox-table/outbox-table-construct";
import { SearchProductsLambdaConstruct } from "./constructs/lambda/discovery/search-products/search-products-lambda-construct";
import { InterpretCollectorQueryLambdaConstruct } from "./constructs/lambda/discovery/interpret-collector-query/interpret-collector-query-lambda-construct";
import { GenerateFeedLambdaConstruct } from "./constructs/lambda/discovery/generate-feed/generate-feed-lambda-construct";
import { GenerateRecommendationsLambdaConstruct } from "./constructs/lambda/discovery/generate-recommendations/generate-recommendations-lambda-construct";
import { GetCuratedCollectionLambdaConstruct } from "./constructs/lambda/discovery/get-curated-collection/get-curated-collection-lambda-construct";
import { UpdateSearchIndexLambdaConstruct } from "./constructs/lambda/discovery/update-search-index/update-search-index-lambda-construct";
import { DiscoveryAppSyncResolversConstruct } from "./constructs/appsync/discovery-appsync-resolvers/discovery-appsync-resolvers-construct";
import { ProductEventConsumerLambdaConstruct } from "./constructs/lambda/event-consumer/product-event-consumer-lambda-construct";
import { ProductShelfItemUpdatedConsumerLambdaConstruct } from "./constructs/lambda/event-consumer/product-shelf-item-updated-consumer-lambda-construct";
import { StockHoldCreatedConsumerLambdaConstruct } from "./constructs/lambda/event-consumer/stock-hold-created-consumer-lambda-construct";
import { StockHoldExpiredConsumerLambdaConstruct } from "./constructs/lambda/event-consumer/stock-hold-expired-consumer-lambda-construct";
import { OrderStockConfirmedConsumerLambdaConstruct } from "./constructs/lambda/event-consumer/order-stock-confirmed-consumer-lambda-construct";
import { RepublishLambdaConstruct } from "./constructs/lambda/republish/republish-lambda-construct";
import { importEventBusFromSharedInfra } from "./utils/eventbridge-helper";

export class ShelfDiscoveryDomainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Domain", "hand-made-shelf-discovery-domain");
    cdk.Tags.of(this).add("Environment", props.environment);
    cdk.Tags.of(this).add("Project", "hand-made");
    cdk.Tags.of(this).add("Region", props.regionCode);
    cdk.Tags.of(this).add("StackName", this.stackName);

    const removalPolicy = props.environment === 'prod'
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // Import shared EventBridge bus
    const sharedEventBus = importEventBusFromSharedInfra(this, props.environment);
    const schemaRegistryName = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.environment}/shared-infra/glue/schema-registry-name`,
    );

    // Idempotency table for event deduplication
    const idempotencyTable = new dynamodb.Table(this, "DiscoveryIdempotencyTable", {
      tableName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-idempotency`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expires_at",
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === "prod" },
    });

    // Create DynamoDB tables
    const discoveryTables = new DiscoveryTablesConstruct(this, "DiscoveryTables", {
      environment: props.environment,
      regionCode: props.regionCode,
      removalPolicy,
    });

    const outboxTable = new OutboxTableConstruct(this, "OutboxTable", {
      environment: props.environment,
      regionCode: props.regionCode,
      domainName: "shelf-discovery-domain",
      removalPolicy,
    });

    const discoveryAppSync = new DiscoveryAppSyncConstruct(this, "DiscoveryAppSync", {
      environment: props.environment,
      regionCode: props.regionCode,
    });

    // Create Lambda functions
    const searchProductsLambda = new SearchProductsLambdaConstruct(this, "SearchProductsLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      shelfItemsTable: discoveryTables.shelfItemsTable,
      removalPolicy,
    });

    const interpretCollectorQueryLambda = new InterpretCollectorQueryLambdaConstruct(this, "InterpretCollectorQueryLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      removalPolicy,
    });

    const generateFeedLambda = new GenerateFeedLambdaConstruct(this, "GenerateFeedLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      removalPolicy,
    });

    const generateRecommendationsLambda = new GenerateRecommendationsLambdaConstruct(this, "GenerateRecommendationsLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      searchDocumentsTable: discoveryTables.searchDocumentsTable,
      removalPolicy,
    });

    const getCuratedCollectionLambda = new GetCuratedCollectionLambdaConstruct(this, "GetCuratedCollectionLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      curatedCollectionsTable: discoveryTables.curatedCollectionsTable,
      collectionProductsTable: discoveryTables.collectionProductsTable,
      removalPolicy,
    });

    // ========== REPUBLISH LAMBDA: Outbox event publisher ==========
    new RepublishLambdaConstruct(this, "RepublishLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      domainName: "shelf-discovery-domain",
      outboxTable: outboxTable.table,
      eventBus: sharedEventBus,
      schemaRegistryName,
      removalPolicy,
    });


    // ========== EVENT CONSUMER: Product Events from Product Domain ==========
    // This consumer listens for product lifecycle events and updates the shelf_items table
    const productEventConsumer = new ProductEventConsumerLambdaConstruct(this, "ProductEventConsumer", {
      environment: props.environment,
      regionCode: props.regionCode,
      eventBus: sharedEventBus,
      shelfItemsTable: discoveryTables.shelfItemsTable,
      soldOutItemsTable: discoveryTables.soldOutItemsTable,
      idempotencyTable,
      schemaRegistryName,
      removalPolicy,
    });

    // ========== EVENT CONSUMER: Product Shelf Item Updated Events ==========
    // This consumer listens for product.shelf.item.updated.v1 events and updates search index
    const productShelfItemUpdatedConsumer = new ProductShelfItemUpdatedConsumerLambdaConstruct(this, "ProductShelfItemUpdatedConsumer", {
      environment: props.environment,
      regionCode: props.regionCode,
      outboxTable: outboxTable.table,
      eventBus: sharedEventBus,
      removalPolicy,
    });

    // ========== EVENT CONSUMER: Stock Hold Created Events ==========
    // This consumer listens for stock.hold.created.v1 events from Order Domain and decrements quantityAvailable
    const stockHoldCreatedConsumer = new StockHoldCreatedConsumerLambdaConstruct(this, "StockHoldCreatedConsumer", {
      environment: props.environment,
      regionCode: props.regionCode,
      eventBus: sharedEventBus,
      shelfItemsTable: discoveryTables.shelfItemsTable,
      idempotencyTable,
      removalPolicy,
    });

    // ========== EVENT CONSUMER: Stock Hold Expired Events ==========
    // This consumer listens for stock.hold.expired.v1 events from Order Domain and restores quantityAvailable
    const stockHoldExpiredConsumer = new StockHoldExpiredConsumerLambdaConstruct(this, "StockHoldExpiredConsumer", {
      environment: props.environment,
      regionCode: props.regionCode,
      eventBus: sharedEventBus,
      shelfItemsTable: discoveryTables.shelfItemsTable,
      idempotencyTable,
      removalPolicy,
    });

    // ========== EVENT CONSUMER: Order Stock Confirmed Events ==========
    // This consumer listens for order.stock.confirmed.v1 events from Order Domain and increments quantitySold
    const orderStockConfirmedConsumer = new OrderStockConfirmedConsumerLambdaConstruct(this, "OrderStockConfirmedConsumer", {
      environment: props.environment,
      regionCode: props.regionCode,
      eventBus: sharedEventBus,
      shelfItemsTable: discoveryTables.shelfItemsTable,
      idempotencyTable,
      removalPolicy,
    });

    const updateSearchIndexLambda = new UpdateSearchIndexLambdaConstruct(this, "UpdateSearchIndexLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      searchDocumentsTable: discoveryTables.searchDocumentsTable,
      removalPolicy,
    });

    // Export DynamoDB table names to SSM for other domains to import
    new ssm.StringParameter(this, "ShelfItemsTableNameParameter", {
      parameterName: `/${props.environment}/shelf-discovery-domain/dynamodb/shelf-items-table-name`,
      stringValue: discoveryTables.shelfItemsTable.tableName,
      description: "Shelf items table name from shelf-discovery-domain",
    });

    new ssm.StringParameter(this, "SoldOutItemsTableNameParameter", {
      parameterName: `/${props.environment}/shelf-discovery-domain/dynamodb/sold-out-items-table-name`,
      stringValue: discoveryTables.soldOutItemsTable.tableName,
      description: "Sold out items table name from shelf-discovery-domain",
    });

    // Create AppSync resolvers
    const discoveryResolvers = new DiscoveryAppSyncResolversConstruct(this, "DiscoveryResolvers", {
      api: discoveryAppSync.api,
      searchProductsLambda: searchProductsLambda.function,
      interpretCollectorQueryLambda: interpretCollectorQueryLambda.function,
      generateFeedLambda: generateFeedLambda.function,
      generateRecommendationsLambda: generateRecommendationsLambda.function,
      getCuratedCollectionLambda: getCuratedCollectionLambda.function,
      updateSearchIndexLambda: updateSearchIndexLambda.function,
    });
  }
}
