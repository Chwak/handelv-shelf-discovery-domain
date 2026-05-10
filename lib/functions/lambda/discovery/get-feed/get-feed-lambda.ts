import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import { requireAuthenticatedUser } from '../../../../utils/validation-utils';
import { randomUUID } from 'crypto';

'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.SHELF_ITEMS_TABLE_NAME;
const DEFAULT_LIMIT = 48;
const MAX_LIMIT = 200;

function parseLimit(limit: unknown): number {
  if (limit == null) return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseNextToken(token: unknown): Record<string, unknown> | undefined {
  if (!token || typeof token !== 'string') return undefined;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function encodeNextToken(lastKey: Record<string, unknown> | undefined): string | null {
  if (!lastKey || Object.keys(lastKey).length === 0) return null;
  return Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64url');
}

function itemToFeedItem(item: Record<string, unknown>) {
  return {
    shelfItemId: item.shelfItemId,
    title: item.title || '',
    description: item.description || '',
    makerUserId: item.makerUserId || '',
    makerName: item.makerName || '',
    categoryId: item.categoryId ?? null,
    basePrice: Number(item.basePrice) || 0,
    rating: item.rating != null ? Number(item.rating) : null,
    primaryImageUrl: item.primaryImageUrl ?? null,
    feedScore: item.relevanceScore != null ? Number(item.relevanceScore) : null,
    createdAt: (item.createdAt as string) || (item.publishedAt as string) || new Date().toISOString(),
  };
}

function resolveTraceparent(event: { headers?: Record<string, string> }): string {
  const h = event.headers?.traceparent || event.headers?.Traceparent;
  const isValid = h && /^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/i.test(h);
  if (isValid) return h!;
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

exports.handler = async (event: { arguments?: Record<string, unknown>; headers?: Record<string, string> }) => {
  initTelemetryLogger(event, { domain: 'shelf-discovery-domain', service: 'get-feed' });
  resolveTraceparent(event);

  const authUserId = requireAuthenticatedUser(event as { identity?: { sub?: string; claims?: { sub?: string } } });
  if (!authUserId) throw new Error('Not authenticated');

  const args = event.arguments || {};
  const limit = parseLimit(args.limit);
  const exclusiveStartKey = parseNextToken(args.nextToken);

  if (!TABLE_NAME) {
    console.error('SHELF_ITEMS_TABLE_NAME not configured');
    return { items: [], nextToken: null };
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // Scan all ACTIVE shelf items — stock availability is enforced at checkout,
  // not at discovery time (sold-out items should still be discoverable)
  const res = await client.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: '#shelfStatus = :active',
      ExpressionAttributeNames: {
        '#shelfStatus': 'shelfStatus',
      },
      ExpressionAttributeValues: {
        ':active': 'ACTIVE',
      },
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  // Sort by createdAt DESC so the newest items always appear first,
  // then shuffle the tail so older inventory still gets exposure.
  const all = (res.Items || []).sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ta = (a.createdAt as string) || (a.publishedAt as string) || '';
    const tb = (b.createdAt as string) || (b.publishedAt as string) || '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });

  // Keep newest `recentCount` items pinned at the front, shuffle the rest
  const recentCount = Math.min(5, all.length);
  const recent = all.slice(0, recentCount);
  const rest = all.slice(recentCount);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  const items = [...recent, ...rest].slice(0, limit).map(itemToFeedItem);

  console.log(`getFeed returning ${items.length} items`);

  return {
    items,
    nextToken: encodeNextToken(res.LastEvaluatedKey),
  };
};
