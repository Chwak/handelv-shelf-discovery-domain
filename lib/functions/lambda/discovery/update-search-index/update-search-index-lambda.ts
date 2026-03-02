import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

function resolveTraceparent(event: { headers?: Record<string, string> }): string {
  const headerTraceparent = event.headers?.traceparent || event.headers?.Traceparent;
  const isValid = headerTraceparent && /^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/i.test(headerTraceparent);
  if (isValid) return headerTraceparent;
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

const SEARCH_DOCUMENTS_TABLE = process.env.SEARCH_DOCUMENTS_TABLE_NAME;

function validateProductId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return t.length > 0 && t.length <= 200 ? t : null;
}

export const handler = async (event: {
  arguments?: { productId?: unknown; action?: unknown; document?: Record<string, unknown> };
  headers?: Record<string, string>;
}) => {
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "update-search-index" });
  const traceparent = resolveTraceparent(event);
  if (!SEARCH_DOCUMENTS_TABLE) {
    console.error('SEARCH_DOCUMENTS_TABLE_NAME is not configured');
    throw new Error('Internal server error');
  }

  const args = event.arguments ?? {};
  const productId = validateProductId(args.productId);
  if (!productId) throw new Error('Invalid input format');

  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'upsert';
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  if (action === 'delete') {
    await client.send(
      new DeleteCommand({
        TableName: SEARCH_DOCUMENTS_TABLE,
        Key: { productId },
      })
    );
    return true;
  }

  const document = args.document && typeof args.document === 'object' ? args.document : {};
  const updatedAt = new Date().toISOString();
  const item = {
    productId,
    updatedAt,
    ...document,
  };
  await client.send(
    new PutCommand({
      TableName: SEARCH_DOCUMENTS_TABLE,
      Item: item,
    })
  );
  return true;
};