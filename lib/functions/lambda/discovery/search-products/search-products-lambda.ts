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
const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'for', 'of', 'to', 'in', 'on', 'with', 'by', 'from']);
const SYNONYM_MAP: Record<string, string[]> = {
  ceramic: ['pottery', 'stoneware', 'porcelain', 'earthenware'],
  ceramics: ['pottery', 'stoneware', 'porcelain', 'earthenware'],
  pottery: ['ceramic', 'ceramics', 'stoneware'],
  textile: ['textiles', 'fabric', 'woven', 'weaving'],
  textiles: ['textile', 'fabric', 'woven', 'weaving'],
  jewelry: ['jewellery', 'gemstone'],
  jewellery: ['jewelry', 'gemstone'],
  metalwork: ['blacksmithing', 'silversmithing', 'casting'],
  wood: ['woodwork', 'carved', 'turning'],
  glass: ['crystal', 'blown', 'stained'],
  leather: ['hide', 'strap', 'bag'],
};

function normalizeForSearch(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: unknown): string[] {
  const normalized = normalizeForSearch(value);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function uniqueLimited(values: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function buildSearchTerms(rawQuery: string): { normalizedQuery: string; tokens: string[]; expandedTokens: string[] } {
  const normalizedQuery = normalizeForSearch(rawQuery);
  const tokens = uniqueLimited(tokenize(normalizedQuery), 8);
  const expansions: string[] = [];
  for (const token of tokens) {
    expansions.push(token);
    const related = SYNONYM_MAP[token];
    if (Array.isArray(related)) expansions.push(...related.map((v) => normalizeForSearch(v)));
  }
  const expandedTokens = uniqueLimited(expansions, 12);
  return { normalizedQuery, tokens, expandedTokens };
}

function isWithinEditDistance(source: string, target: string, maxDistance = 2): boolean {
  if (source === target) return true;
  const a = source;
  const b = target;
  if (Math.abs(a.length - b.length) > maxDistance) return false;
  if (!a.length || !b.length) return false;

  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let minInRow = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + cost,
      );
      cur.push(next);
      if (next < minInRow) minInRow = next;
    }
    if (minInRow > maxDistance) return false;
    prev = cur;
  }
  return prev[b.length] <= maxDistance;
}

function popularityScore(item: Record<string, unknown>): number {
  const orderCount = Number(item.orderCount) || 0;
  const saveCount = Number(item.saveCount) || 0;
  const viewCount = Number(item.viewCount) || 0;
  const rating = Number(item.rating) || 0;
  return orderCount * 2 + saveCount * 1.25 + viewCount * 0.1 + rating * 2;
}

function computeRelevanceScore(
  item: Record<string, unknown>,
  search: { normalizedQuery: string; tokens: string[]; expandedTokens: string[] },
): number {
  const title = normalizeForSearch(item.title);
  const desc = normalizeForSearch(item.description);
  const maker = normalizeForSearch(item.makerName);
  const categoryId = normalizeForSearch(item.categoryId);
  const searchable = normalizeForSearch(item.searchableText) || `${title} ${desc} ${maker} ${categoryId}`;
  const titleWords = tokenize(title);
  const makerWords = tokenize(maker);

  let score = 0;
  let matched = false;

  if (!search.normalizedQuery) return Number(score.toFixed(4));

  if (title === search.normalizedQuery) { score += 120; matched = true; }
  if (title.startsWith(search.normalizedQuery)) { score += 70; matched = true; }
  if (title.includes(search.normalizedQuery)) { score += 55; matched = true; }
  if (maker.includes(search.normalizedQuery)) { score += 30; matched = true; }
  if (desc.includes(search.normalizedQuery)) { score += 18; matched = true; }
  if (searchable.includes(search.normalizedQuery)) { score += 22; matched = true; }

  for (const token of search.expandedTokens) {
    if (!token) continue;
    if (titleWords.includes(token)) { score += 14; matched = true; }
    else if (title.includes(token)) { score += 9; matched = true; }

    if (makerWords.includes(token)) { score += 8; matched = true; }
    else if (maker.includes(token)) { score += 5; matched = true; }

    if (desc.includes(token)) { score += 4; matched = true; }
    if (categoryId.includes(token)) { score += 3; matched = true; }
    if (searchable.includes(token)) { score += 5; matched = true; }

    if (token.length >= 4) {
      const nearTitle = titleWords.some((word) => isWithinEditDistance(word, token, 1));
      const nearMaker = makerWords.some((word) => isWithinEditDistance(word, token, 1));
      if (nearTitle) { score += 6; matched = true; }
      if (nearMaker) { score += 3; matched = true; }
    }
  }

  if (!matched) return 0;

  score += popularityScore(item) * 0.03;

  return Number(score.toFixed(4));
}

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
  const computedScore = item._computedRelevanceScore != null ? Number(item._computedRelevanceScore) : null;
  return {
    shelfItemId: item.shelfItemId,
    title: item.title || '',
    description: item.description || '',
    makerUserId: item.makerUserId || '',
    makerName: item.makerName || null,
    categoryId: item.categoryId || '',
    basePrice: Number(item.basePrice) || 0,
    rating: item.rating != null ? Number(item.rating) : null,
    primaryImageUrl: item.primaryImageUrl ?? null,
    viewCount: item.viewCount != null ? Number(item.viewCount) : null,
    saveCount: item.saveCount != null ? Number(item.saveCount) : null,
    orderCount: item.orderCount != null ? Number(item.orderCount) : null,
    relevanceScore: computedScore != null ? computedScore : (item.relevanceScore != null ? Number(item.relevanceScore) : null),
  };
}

function buildFilterExpression(
  args: Record<string, unknown>,
  opts: { skipCategoryFilter?: boolean; searchTerms?: string[]; normalizedQuery?: string; skipTextSearch?: boolean } = {},
): { expression: string | null; names: Record<string, string> | null; values: Record<string, unknown> | null } {
  const conditions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  // Only show items that are ACTIVE
  conditions.push('#shelfStatus = :active');
  names['#shelfStatus'] = 'shelfStatus';
  values[':active'] = 'ACTIVE';

  // ── Text search ─────────────────────────────────────────────────────────────
  // Use pre-computed lowercase searchableText when available (case-insensitive).
  // Fall back to raw title/description/makerName for older items that lack it.
  const query = (typeof args.query === 'string' ? args.query : '').trim();
  if (query.length > 0 && !opts.skipTextSearch) {
    const normalizedQuery = opts.normalizedQuery || normalizeForSearch(query);
    const terms = uniqueLimited(opts.searchTerms || [], 6);
    conditions.push(
      '(' +
        'contains(#searchableText, :normalizedQuery)' +
        ' OR contains(#title, :normalizedQuery)' +
        ' OR contains(#desc, :normalizedQuery)' +
        ' OR contains(#makerName, :normalizedQuery)' +
        (terms.length ? ` OR ${terms.map((_, idx) => `contains(#searchableText, :term${idx})`).join(' OR ')}` : '') +
      ')',
    );
    names['#searchableText'] = 'searchableText';
    names['#title']          = 'title';
    names['#desc']           = 'description';
    names['#makerName']      = 'makerName';
    // Single value covers every branch — lowercase covers case-insensitive matches
    values[':normalizedQuery'] = normalizedQuery;
    terms.forEach((term, idx) => {
      values[`:term${idx}`] = term;
    });
  }

  // ── Price / rating filters ───────────────────────────────────────────────────
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

  // ── Category filter — skip when categoryId is already the GSI key condition ──
  if (!opts.skipCategoryFilter && args.categoryId && typeof args.categoryId === 'string' && args.categoryId.trim()) {
    conditions.push('categoryId = :categoryId');
    values[':categoryId'] = args.categoryId.trim();
  }

  const materials = Array.isArray(args.materials) ? (args.materials as string[]).filter((m: string) => typeof m === 'string' && m.trim()) : [];
  if (materials.length > 0) {
    conditions.push('(attribute_exists(materials) AND size(materials) > :zero)');
    values[':zero'] = 0;
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
  const search = buildSearchTerms(typeof args.query === 'string' ? args.query : '');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  if (!TABLE_NAME) {
    return { items: [], nextToken: null, totalCount: 0 };
  }

  const filter = buildFilterExpression(args, {
    skipCategoryFilter: false,
    searchTerms: search.expandedTokens,
    normalizedQuery: search.normalizedQuery,
  });
  const requestLimit = filter.expression ? Math.min(limit * 5, 500) : limit;

  let items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined = nextToken;

  const fetchByFilter = async (appliedFilter: { expression: string | null; names: Record<string, string> | null; values: Record<string, unknown> | null }) => {
    if (makerUserId) {
      const qValues = { ':maker': makerUserId, ...(appliedFilter.values || {}) };
      const res = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_MAKER,
        KeyConditionExpression: 'makerUserId = :maker',
        FilterExpression: appliedFilter.expression || undefined,
        ExpressionAttributeNames: appliedFilter.names || undefined,
        ExpressionAttributeValues: qValues,
        Limit: requestLimit,
        ExclusiveStartKey: lastKey,
      }));
      return { items: res.Items || [], lastKey: res.LastEvaluatedKey };
    }

    if (args.categoryId && typeof args.categoryId === 'string' && args.categoryId.trim()) {
      const qValues = { ':cat': args.categoryId.trim(), ...(appliedFilter.values || {}) };
      const res = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_CATEGORY,
        KeyConditionExpression: 'categoryId = :cat',
        FilterExpression: appliedFilter.expression || undefined,
        ExpressionAttributeNames: appliedFilter.names || undefined,
        ExpressionAttributeValues: qValues,
        Limit: requestLimit,
        ExclusiveStartKey: lastKey,
      }));
      return { items: res.Items || [], lastKey: res.LastEvaluatedKey };
    }

    const res = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: appliedFilter.expression || undefined,
      ExpressionAttributeNames: appliedFilter.names || undefined,
      ExpressionAttributeValues: appliedFilter.values || undefined,
      Limit: requestLimit,
      ExclusiveStartKey: lastKey,
    }));
    return { items: res.Items || [], lastKey: res.LastEvaluatedKey };
  };

  try {
    const strictFilter = makerUserId
      ? filter
      : (args.categoryId && typeof args.categoryId === 'string' && args.categoryId.trim())
        ? buildFilterExpression(args, {
            skipCategoryFilter: true,
            searchTerms: search.expandedTokens,
            normalizedQuery: search.normalizedQuery,
          })
        : filter;

    ({ items, lastKey } = await fetchByFilter(strictFilter));

    if (search.normalizedQuery && items.length === 0) {
      const relaxedFilter = makerUserId
        ? buildFilterExpression(args, {
            skipCategoryFilter: false,
            skipTextSearch: true,
            searchTerms: search.expandedTokens,
            normalizedQuery: search.normalizedQuery,
          })
        : (args.categoryId && typeof args.categoryId === 'string' && args.categoryId.trim())
          ? buildFilterExpression(args, {
              skipCategoryFilter: true,
              skipTextSearch: true,
              searchTerms: search.expandedTokens,
              normalizedQuery: search.normalizedQuery,
            })
          : buildFilterExpression(args, {
              skipCategoryFilter: false,
              skipTextSearch: true,
              searchTerms: search.expandedTokens,
              normalizedQuery: search.normalizedQuery,
            });

      ({ items, lastKey } = await fetchByFilter(relaxedFilter));
    }

    if (Array.isArray(args.materials) && args.materials.length > 0) {
      items = filterByMaterials(items, args.materials);
    }

    items = items
      .map((item) => ({
        ...item,
        _computedRelevanceScore: computeRelevanceScore(item, search),
      }))
      .filter((item) => !search.normalizedQuery || Number(item._computedRelevanceScore) > 0)
      .sort((a, b) => {
        const scoreDiff = (Number(b._computedRelevanceScore) || 0) - (Number(a._computedRelevanceScore) || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return popularityScore(b) - popularityScore(a);
      });

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