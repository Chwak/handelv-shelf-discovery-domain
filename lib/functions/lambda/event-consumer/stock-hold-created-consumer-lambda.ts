import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { initTelemetryLogger } from '../../../utils/telemetry-logger';

const SHELF_ITEMS_TABLE_NAME = process.env.SHELF_ITEMS_TABLE_NAME || '';
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME || '';

interface StockHoldCreatedEvent {
  holdId: string;
  shelfItemId: string;
  quantity: number;
  collectorUserId: string;
  makerUserId: string;
  expiresAt: number;
  timestamp: string;
}

const dynamodbClient = new DynamoDBClient({});
const dynamodbDoc = DynamoDBDocumentClient.from(dynamodbClient);

export const handler = async (event: SQSEvent): Promise<{
  batchItemFailures: Array<{ itemIdentifier: string }>;
}> => {
  initTelemetryLogger(event, { domain: 'shelf-discovery-domain', service: 'stock-hold-created-consumer' });
  
  console.log('========== STOCK HOLD CREATED CONSUMER START (Shelf-Discovery Domain) ==========');

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  if (!SHELF_ITEMS_TABLE_NAME || !IDEMPOTENCY_TABLE_NAME) {
    console.error('SHELF_ITEMS_TABLE_NAME or IDEMPOTENCY_TABLE_NAME not set');
    throw new Error('Internal server error');
  }

  for (const record of event.Records || []) {
    const messageId = record.messageId || 'unknown';
    try {
      console.log(`\n---------- Processing Record: ${messageId} ----------`);

      if (!record.body) {
        throw new Error('Empty SQS message body');
      }

      // Parse SQS message (wrapped EventBridge event)
      let eventBridgeEnvelope;
      try {
        eventBridgeEnvelope = JSON.parse(record.body);
      } catch (e) {
        console.error('Failed to parse SQS body as JSON', { messageId });
        throw e;
      }


      const detail = eventBridgeEnvelope.detail as StockHoldCreatedEvent;
      if (!detail) {
        throw new Error('Missing detail in EventBridge envelope');
      }

      const { holdId, shelfItemId, quantity } = detail;

      // Validate required fields
      if (!holdId || !shelfItemId || !quantity) {
        throw new Error(
          `Missing required fields: holdId=${holdId}, shelfItemId=${shelfItemId}, quantity=${quantity}`
        );
      }

      console.log('Stock Hold Created Event:', { holdId, shelfItemId, quantity });

      // Check idempotency
      try {
        const idempotencyKey = holdId;
        const idempotencyResult = await dynamodbDoc.send(
          new GetCommand({
            TableName: IDEMPOTENCY_TABLE_NAME,
            Key: { id: idempotencyKey },
          })
        );

        if (idempotencyResult.Item) {
          console.log(`Hold ${holdId} already processed, skipping`);
          continue;
        }
      } catch (err) {
        console.warn('Failed to check idempotency, proceeding anyway', { err });
      }

      // ATOMIC DECREMENT: Reserve stock by decrementing quantityAvailable
      // Use ConditionExpression to prevent overselling (race condition protection)
      const now = new Date().toISOString();
      
      try {
        await dynamodbDoc.send(
          new UpdateCommand({
            TableName: SHELF_ITEMS_TABLE_NAME,
            Key: { shelfItemId },
            UpdateExpression: 'SET quantityAvailable = quantityAvailable - :qty, updatedAt = :now',
            ConditionExpression: 'quantityAvailable >= :qty',
            ExpressionAttributeValues: {
              ':qty': quantity,
              ':now': now,
            },
          })
        );

        console.log(`✅ Stock reserved: shelfItemId=${shelfItemId}, quantity=${quantity}`);
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          console.error('Insufficient stock for hold creation', {
            shelfItemId,
            requested: quantity,
          });
          throw new Error(`Insufficient stock: shelfItemId=${shelfItemId}, requested=${quantity}`);
        }
        throw err;
      }

      // Record idempotency
      try {
        const idempotencyTTL = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days (was 24h)
        await dynamodbDoc.send(
          new PutCommand({
            TableName: IDEMPOTENCY_TABLE_NAME,
            Item: {
              id: holdId,
              processed: true,
              createdAt: now,
              expires_at: idempotencyTTL,
            },
          })
        );
      } catch (err) {
        console.warn('Failed to record idempotency:', err);
      }

      console.log(`✅ Stock hold processed: holdId=${holdId}, shelfItemId=${shelfItemId}`);
    } catch (err) {
      console.error(`❌ Error processing record ${messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId || messageId });
    }
  }

  console.log('========== STOCK HOLD CREATED CONSUMER END ==========');
  return { batchItemFailures };
};
