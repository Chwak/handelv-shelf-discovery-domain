import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DiscoveryTablesConstructProps {
  environment: string;
  regionCode: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class DiscoveryTablesConstruct extends Construct {
  public readonly searchDocumentsTable: dynamodb.Table;
  public readonly shelfItemsTable: dynamodb.Table;
  public readonly soldOutItemsTable: dynamodb.Table;
  public readonly curatedCollectionsTable: dynamodb.Table;
  public readonly collectionProductsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DiscoveryTablesConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;

    // Search Documents Table
    this.searchDocumentsTable = new dynamodb.Table(this, 'SearchDocumentsTable', {
      tableName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-search-documents-table`,
      partitionKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: search documents by category and rating
    this.searchDocumentsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-CategoryRating',
      partitionKey: {
        name: 'categoryId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'rating',
        type: dynamodb.AttributeType.NUMBER,
      },
    });

    // GSI: search documents by category and view count
    this.searchDocumentsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-CategoryViews',
      partitionKey: {
        name: 'categoryId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'viewCount',
        type: dynamodb.AttributeType.NUMBER,
      },
    });

    // ==================== SHELF ITEMS TABLE ====================
    // This is the DENORMALIZED view of products that are on the SHELF
    // Updated via events from Product Domain
    // Optimized for search and discovery queries
    this.shelfItemsTable = new dynamodb.Table(this, 'ShelfItemsTable', {
      tableName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-shelf-items-table`,
      partitionKey: {
        name: 'shelfItemId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES, // For real-time search index updates
    });

    // GSI1: Browse shelf items by maker
    this.shelfItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-MakerPublished',
      partitionKey: {
        name: 'makerUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'publishedAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Browse shelf items by category with bestseller ranking
    this.shelfItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-CategoryBestseller',
      partitionKey: {
        name: 'categoryId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'orderCount',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: Browse shelf items by category with price (for price filters)
    this.shelfItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI3-CategoryPrice',
      partitionKey: {
        name: 'categoryId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'basePrice',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI4: New arrivals (global browse by published date)
    this.shelfItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI4-NewArrivals',
      partitionKey: {
        name: 'shelfStatus',
        type: dynamodb.AttributeType.STRING, // Always "ACTIVE" for items on shelf
      },
      sortKey: {
        name: 'publishedAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ==================== SOLD OUT ITEMS TABLE ====================
    // Items that have reached quantityAvailable = 0
    // Moved from shelf_items when inventory is depleted
    // Kept separate for analytics and historical tracking
    this.soldOutItemsTable = new dynamodb.Table(this, 'SoldOutItemsTable', {
      tableName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-sold-out-items-table`,
      partitionKey: {
        name: 'shelfItemId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: sold out items by maker (for analytics)
    this.soldOutItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-MakerSoldOut',
      partitionKey: {
        name: 'makerUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'soldOutAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: sold out items by category
    this.soldOutItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-CategorySoldOut',
      partitionKey: {
        name: 'categoryId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'soldOutAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Curated Collections Table
    this.curatedCollectionsTable = new dynamodb.Table(this, 'CuratedCollectionsTable', {
      tableName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-curated-collections-table`,
      partitionKey: {
        name: 'collectionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: curated collections by featured
    this.curatedCollectionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-Featured',
      partitionKey: {
        name: 'featured',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'publishedAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Collection Products Table
    this.collectionProductsTable = new dynamodb.Table(this, 'CollectionProductsTable', {
      tableName: `${props.environment}-${props.regionCode}-shelf-discovery-domain-collection-products-table`,
      partitionKey: {
        name: 'collectionId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: collection items by product
    this.collectionProductsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-ProductId',
      partitionKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
    });
  }
}
