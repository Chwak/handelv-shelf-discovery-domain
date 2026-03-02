import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import { requireAuthenticatedUser } from '../../../../utils/validation-utils';

const SEARCH_DOCUMENTS_TABLE = process.env.SEARCH_DOCUMENTS_TABLE_NAME;

function validateId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return t.length > 0 && t.length <= 200 ? t : null;
}

export const handler = async (event: { arguments?: { userId?: unknown }; identity?: { sub?: string; claims?: { sub?: string } } }) => {
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "generate-recommendations" });
  if (!SEARCH_DOCUMENTS_TABLE) {
    console.error('SEARCH_DOCUMENTS_TABLE_NAME is not configured');
    throw new Error('Internal server error');
  }

  const args = event.arguments ?? {};
  const userId = validateId(args.userId);
  if (!userId) throw new Error('Invalid input format');

  const authUserId = requireAuthenticatedUser(event);
  if (!authUserId) throw new Error('Not authenticated');
  if (authUserId !== userId) throw new Error('Forbidden');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const scanResult = await client.send(
    new ScanCommand({
      TableName: SEARCH_DOCUMENTS_TABLE,
      Limit: 100,
    })
  );
  const items = (scanResult.Items ?? []) as Record<string, unknown>[];
  const withScore = items.map((item) => {
    const rating = Number(item.rating) || 0;
    const viewCount = Number(item.viewCount) || 0;
    const score = rating * 2 + Math.min(viewCount / 100, 10);
    return { ...item, _score: score };
  });
  withScore.sort((a, b) => (b._score as number) - (a._score as number));
  const top = withScore.slice(0, 20).map(({ _score, ...rest }) => rest);
  console.log('generateRecommendations completed', { userId, candidateCount: top.length });
  return true;
};