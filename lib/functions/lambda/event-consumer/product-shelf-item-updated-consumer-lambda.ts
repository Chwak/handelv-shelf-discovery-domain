import { randomUUID } from "crypto";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { SQSEvent, SQSRecord } from "aws-lambda";

const dynamodb = new DynamoDBClient({});
const dynamodbDoc = DynamoDBDocumentClient.from(dynamodb);

const SEARCH_INDEX_TABLE_NAME = process.env.SEARCH_INDEX_TABLE_NAME;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME;
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME;

if (!SEARCH_INDEX_TABLE_NAME || !IDEMPOTENCY_TABLE_NAME || !OUTBOX_TABLE_NAME) {
  throw new Error("Missing required environment variables");
}

interface ProductShelfItemUpdatedEvent {
  productId: string;
  shelfItemId: string;
  makerId: string;
  title: string;
  description: string;
  price?: number;
  basePrice?: number;
  currency?: string;
  quantityAvailable: number;
  quantitySold: number;
  status: string;
  imageUrls: string[];
  categoryId: string;
  updatedAt: string;
}

interface SearchIndexEntry {
  searchIndexId: string;
  productId: string;
  shelfItemId: string;
  makerId: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  quantityAvailable: number;
  quantitySold: number;
  status: string;
  imageUrls: string[];
  categoryId: string;
  searchableText: string; // For full-text search
  updatedAt: string;
  createdAt: string;
}

export async function handler(event: SQSEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  console.log("Product shelf item updated consumer start", { recordCount: event.Records.length });

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error(`Error processing record ${record.messageId}:`, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

async function processRecord(record: SQSRecord): Promise<void> {
  // Parse SQS message body (EventBridge envelope)
  const body = JSON.parse(record.body);
  const detail = body.detail as ProductShelfItemUpdatedEvent;

  // Validate required fields
  if (!detail.shelfItemId || !detail.productId || !detail.makerId) {
    throw new Error("Missing required fields: shelfItemId, productId, or makerId");
  }

  const { productId, shelfItemId } = detail;

  console.log(`Processing product.shelf.item.updated.v1 for shelfItemId=${shelfItemId}`);

  // Check idempotency
  const idempotencyResult = await checkIdempotency(shelfItemId);
  if (idempotencyResult?.indexed) {
    console.log(`Product ${shelfItemId} already indexed, skipping`);
    return;
  }

  // Index product in search
  await indexProductInSearch(detail);

  // Record idempotency
  await recordIdempotency(shelfItemId);

  // Publish search.indexed.v1 event for audit trail
  await publishSearchIndexedEvent(productId, shelfItemId);
}

async function indexProductInSearch(product: ProductShelfItemUpdatedEvent): Promise<void> {
  const searchIndexId = `search-index-${randomUUID()}`;
  const now = new Date().toISOString();

  // Create searchable text from title & description
  const searchableText = `${product.title} ${product.description} ${product.categoryId}`.toLowerCase();

  const price = typeof product.price === "number" ? product.price : Number(product.basePrice ?? 0);
  const currency = product.currency || "USD";

  const searchIndexEntry: SearchIndexEntry = {
    searchIndexId,
    productId: product.productId,
    shelfItemId: product.shelfItemId,
    makerId: product.makerId,
    title: product.title,
    description: product.description,
    price,
    currency,
    quantityAvailable: product.quantityAvailable,
    quantitySold: product.quantitySold,
    status: product.status,
    imageUrls: product.imageUrls,
    categoryId: product.categoryId,
    searchableText,
    updatedAt: product.updatedAt,
    createdAt: now,
  };

  console.log(`Indexing product ${product.shelfItemId} in search index`);

  // Add to search index table
  await dynamodbDoc.send(
    new PutCommand({
      TableName: SEARCH_INDEX_TABLE_NAME,
      Item: searchIndexEntry,
    })
  );

  // TODO: In production, also index in Elasticsearch/OpenSearch or Algolia
  console.log(`Product ${product.shelfItemId} indexed successfully`);
}

async function checkIdempotency(shelfItemId: string): Promise<{ indexed: boolean } | null> {
  try {
    const result = await dynamodbDoc.send(
      new GetCommand({
        TableName: IDEMPOTENCY_TABLE_NAME,
        Key: { shelfItemId },
      })
    );

    return result.Item as { indexed: boolean } | null;
  } catch (error) {
    console.warn("Error checking idempotency:", error);
    return null;
  }
}

async function recordIdempotency(shelfItemId: string): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days (was 24h)

  await dynamodbDoc.send(
    new PutCommand({
      TableName: IDEMPOTENCY_TABLE_NAME,
      Item: {
        shelfItemId,
        indexed: true,
        createdAt: new Date().toISOString(),
        ttl,
      },
    })
  );
}

async function publishSearchIndexedEvent(productId: string, shelfItemId: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const eventId = randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days

  console.log(`Publishing search.indexed.v1 to outbox for product ${shelfItemId}`);

  await dynamodbDoc.send(
    new PutCommand({
      TableName: OUTBOX_TABLE_NAME,
      Item: {
        eventId,
        eventType: "search.indexed.v1",
        eventVersion: 1,
        correlationId: shelfItemId,
        payload: JSON.stringify({
          searchIndexEventId: `search-indexed-${randomUUID()}`,
          productId,
          shelfItemId,
          timestamp,
        }),
        status: "PENDING",
        createdAt: timestamp,
        retries: 0,
        expiresAt: ttl,
      },
    })
  );

  console.log(`Published search.indexed.v1 to outbox: ${eventId}`);
}
