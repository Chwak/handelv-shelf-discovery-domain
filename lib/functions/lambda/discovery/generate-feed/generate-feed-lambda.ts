import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import { requireAuthenticatedUser } from '../../../../utils/validation-utils';
/**
 * Mutation: generateFeed(userId: ID!, feedType: FeedType!): Boolean
 * Job-style: validates input and returns true when the generate job completed.
 * Full feed persistence would require a separate feed table; this lambda has no DynamoDB access in the construct.
 */

const FEED_TYPES = new Set(['PERSONALIZED', 'TRENDING', 'NEW_ARRIVALS', 'FOLLOWED_MAKERS']);

function validateId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return t.length > 0 && t.length <= 200 ? t : null;
}

function validateFeedType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return FEED_TYPES.has(v) ? v : null;
}

export const handler = async (event: {
  arguments?: { userId?: unknown; feedType?: unknown };
  identity?: { sub?: string; claims?: { sub?: string } };
}) => {
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "generate-feed" });
  const args = event.arguments ?? {};
  const userId = validateId(args.userId);
  const feedType = validateFeedType(args.feedType);
  if (!userId || !feedType) throw new Error('Invalid input format');

  const authUserId = requireAuthenticatedUser(event);
  if (!authUserId) throw new Error('Not authenticated');
  if (authUserId !== userId) throw new Error('Forbidden');

  console.log('generateFeed job started', { userId, feedType });
  // No table is wired to this lambda in the stack; feed precomputation would be done by a separate pipeline.
  console.log('generateFeed job completed (no persistence)');
  return true;
};