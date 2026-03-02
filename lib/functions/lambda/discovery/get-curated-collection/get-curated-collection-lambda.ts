import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const CURATED_COLLECTIONS_TABLE = process.env.CURATED_COLLECTIONS_TABLE_NAME;
const COLLECTION_PRODUCTS_TABLE = process.env.COLLECTION_PRODUCTS_TABLE_NAME;

function validateId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return t.length > 0 && t.length <= 200 ? t : null;
}

export const handler = async (event: { arguments?: { collectionId?: unknown } }) => {
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "get-curated-collection" });
  if (!CURATED_COLLECTIONS_TABLE || !COLLECTION_PRODUCTS_TABLE) {
    console.error('Table names are not configured');
    throw new Error('Internal server error');
  }

  const collectionId = validateId(event.arguments?.collectionId);
  if (!collectionId) throw new Error('Invalid input format');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const collectionResult = await client.send(
    new GetCommand({
      TableName: CURATED_COLLECTIONS_TABLE,
      Key: { collectionId },
    })
  );
  const collection = collectionResult.Item as Record<string, unknown> | undefined;
  if (!collection) throw new Error('Curated collection not found');

  const productsResult = await client.send(
    new QueryCommand({
      TableName: COLLECTION_PRODUCTS_TABLE,
      KeyConditionExpression: 'collectionId = :cid',
      ExpressionAttributeValues: { ':cid': collectionId },
    })
  );
  const productRows = (productsResult.Items ?? []) as Record<string, unknown>[];
  const products = productRows
    .sort((a, b) => ((a.order as number) ?? 0) - ((b.order as number) ?? 0))
    .map((row) => ({
      productId: row.productId,
      order: row.order ?? 0,
      title: row.title ?? '',
      basePrice: row.basePrice ?? 0,
      primaryImageUrl: row.primaryImageUrl ?? null,
    }));

  return {
    collectionId,
    title: (collection.title as string) ?? '',
    description: (collection.description as string) ?? undefined,
    imageUrl: (collection.imageUrl as string) ?? undefined,
    featured: Boolean(collection.featured),
    products,
    createdAt: (collection.createdAt as string) ?? new Date().toISOString(),
    publishedAt: (collection.publishedAt as string) ?? undefined,
  };
};