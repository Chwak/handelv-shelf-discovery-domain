import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import { randomUUID } from 'crypto';
import { requireAuthenticatedUser } from '../../../../utils/validation-utils';
/**
 * Search products via DynamoDB only (no OpenSearch).
 * Supports query text (contains on title/description), categoryId, price range, minRating, materials.
 */
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

function resolveTraceparent(event: { headers?: Record<string, string> }): string {
  const headerTraceparent = event.headers?.traceparent || event.headers?.Traceparent;
  const isValid = headerTraceparent && /^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/i.test(headerTraceparent);
  if (isValid) return headerTraceparent;
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

const TABLE_NAME = process.env.SHELF_ITEMS_TABLE_NAME;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const GSI_MAKER = 'GSI1-MakerPublished';
const GSI_CATEGORY = 'GSI3-CategoryPrice';

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

function itemToSearchResult(item: Record<string, unknown>) {
  return {
    shelfItemId: item.shelfItemId,
    title: item.title || '',
    description: item.description || '',
    makerUserId: item.makerUserId || '',
    categoryId: item.categoryId || '',
    basePrice: Number(item.basePrice) || 0,
    rating: item.rating != null ? Number(item.rating) : null,
    viewCount: item.viewCount != null ? Number(item.viewCount) : null,
    saveCount: item.saveCount != null ? Number(item.saveCount) : null,
    orderCount: item.orderCount != null ? Number(item.orderCount) : null,
    relevanceScore: item.relevanceScore != null ? Number(item.relevanceScore) : null,
  };
}

function buildFilterExpression(args: Record<string, unknown>, _isQuery: boolean): { expression: string | null; names: Record<string, string> | null; values: Record<string, unknown> | null } {
  const conditions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  // Only show items that are ACTIVE and NOT sold out
  conditions.push('#shelfStatus = :active AND #isSoldOut = :false AND quantityAvailable > :zero');
  names['#shelfStatus'] = 'shelfStatus';
  names['#isSoldOut'] = 'isSoldOut';
  values[':active'] = 'ACTIVE';
  values[':false'] = false;
  values[':zero'] = 0;

  const query = (typeof args.query === 'string' ? args.query : '').trim();
  if (query.length > 0) {
    conditions.push('(contains(#title, :query) OR contains(#desc, :query))');
    names['#title'] = 'title';
    names['#desc'] = 'description';
    values[':query'] = query;
  }

  if (args.minPrice != null && Number(args.minPrice) >= 0) {
    conditions.push('basePrice >= :minPrice');
    values[':minPrice'] = Number(args.minPrice);
  }
  if (args.maxPrice != null && Number(args.maxPrice) >= 0) {
    conditions.push('basePrice <= :maxPrice');
    values[':maxPrice'] = Number(args.maxPrice);
  }
  if (args.minRating != null && Number(args.minRating) >= 0) {
    conditions.push('rating >= :minRating');
    values[':minRating'] = Number(args.minRating);
  }

  if (args.categoryId && typeof args.categoryId === 'string' && args.categoryId.trim()) {
    conditions.push('categoryId = :categoryId');
    values[':categoryId'] = args.categoryId.trim();
  }

  const materials = Array.isArray(args.materials) ? (args.materials as string[]).filter((m: string) => typeof m === 'string' && m.trim()) : [];
  if (materials.length > 0) {
    conditions.push('(attribute_exists(materials) AND size(materials) > 0)');
  }

  if (conditions.length === 0) return { expression: null, names: null, values: null };
  return {
    expression: conditions.join(' AND '),
    names: Object.keys(names).length ? names : null,
    values: Object.keys(values).length ? values : null,
  };
}

function filterByMaterials(items: Record<string, unknown>[], materials: string[]): Record<string, unknown>[] {
  if (!materials || materials.length === 0) return items;
  const lower = materials.map((m: string) => m.toLowerCase());
  return items.filter((item: Record<string, unknown>) => {
    const list = item.materials;
    if (!Array.isArray(list)) return false;
    return list.some((m: unknown) => lower.includes(String(m).toLowerCase()));
  });
}

exports.handler = async (event: { arguments?: Record<string, unknown>; headers?: Record<string, string> }) => {
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "search-products" });
  const traceparent = resolveTraceparent(event);
  const args = event.arguments || {};
  const authUserId = requireAuthenticatedUser(event as { identity?: { sub?: string; claims?: { sub?: string } } });
  if (!authUserId) throw new Error('Not authenticated');
  const rawMakerUserId = typeof args.makerUserId === 'string' ? args.makerUserId.trim() : null;
  const makerUserId = rawMakerUserId || null;
  const limit = parseLimit(args.limit);
  const nextToken = parseNextToken(args.nextToken);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  if (!TABLE_NAME) {
    return { items: [], nextToken: null, totalCount: 0 };
  }

  const filter = buildFilterExpression(args, !!args.categoryId);
  const requestLimit = filter.expression ? Math.min(limit * 5, 500) : limit;

  let items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined = nextToken;

  try {
    if (makerUserId) {
      const qValues = { ':maker': makerUserId, ...(filter.values || {}) };
      const res = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_MAKER,
        KeyConditionExpression: 'makerUserId = :maker',
        ExpressionAttributeValues: qValues,
        Limit: requestLimit,
        ExclusiveStartKey: lastKey,
        FilterExpression: filter.expression || undefined,
        ExpressionAttributeNames: filter.names || undefined,
      }));
      items = res.Items || [];
      lastKey = res.LastEvaluatedKey;
    } else if (args.categoryId && typeof args.categoryId === 'string' && args.categoryId.trim()) {
      const qValues = { ':cat': args.categoryId.trim(), ...(filter.values || {}) };
      const res = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_CATEGORY,
        KeyConditionExpression: 'categoryId = :cat',
        ExpressionAttributeValues: qValues,
        Limit: requestLimit,
        ExclusiveStartKey: lastKey,
        FilterExpression: filter.expression || undefined,
        ExpressionAttributeNames: filter.names || undefined,
      }));
      items = res.Items || [];
      lastKey = res.LastEvaluatedKey;
    } else {
      const res = await client.send(new ScanCommand({
        TableName: TABLE_NAME,
        Limit: requestLimit,
        ExclusiveStartKey: lastKey,
        FilterExpression: filter.expression || undefined,
        ExpressionAttributeNames: filter.names || undefined,
        ExpressionAttributeValues: filter.values || undefined,
      }));
      items = res.Items || [];
      lastKey = res.LastEvaluatedKey;
    }

    if (Array.isArray(args.materials) && args.materials.length > 0) {
      items = filterByMaterials(items, args.materials);
    }

    const results = items.slice(0, limit).map((item: Record<string, unknown>) => itemToSearchResult(item));

    return {
      items: results,
      nextToken: encodeNextToken(lastKey),
      totalCount: results.length,
    };
  } catch (err) {
    console.error('SearchShelfItems error:', err);
    return { items: [], nextToken: null, totalCount: 0 };
  }
};