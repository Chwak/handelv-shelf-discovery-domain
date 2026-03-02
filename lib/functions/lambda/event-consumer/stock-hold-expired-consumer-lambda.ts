import { SQSHandler, SQSEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../utils/telemetry-logger';

const dynamodb = new DynamoDBClient({});
const dynamodbDoc = DynamoDBDocumentClient.from(dynamodb);

const SHELF_ITEMS_TABLE_NAME = process.env.SHELF_ITEMS_TABLE_NAME!;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME!;

/**
 * Stock Hold Expired Consumer (Shelf-Discovery Domain)
 * 
 * Listens for stock.hold.expired.v1 events and restores inventory by incrementing quantityAvailable.
 * This handles abandoned carts or expired holds where users didn't complete payment within the hold TTL (30 minutes).
 * 
 * Flow:
 * 1. Hold expires (detected by expire-stock-holds scheduled lambda in Order domain)
 * 2. stock.hold.expired.v1 event emitted
 * 3. This consumer increments quantityAvailable in shelf_items table
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  initTelemetryLogger(event, { domain: 'shelf-discovery-domain', service: 'stock-hold-expired-consumer' });
  
  console.log('========== STOCK HOLD EXPIRED CONSUMER START (Shelf-Discovery Domain) ==========');

  for (const record of event.Records) {
    try {
      const eventBridgeEvent = JSON.parse(record.body);

      const detail = eventBridgeEvent.detail;
      const { holdId, shelfItemId, quantity } = detail;

      console.log(`Processing expired hold: holdId=${holdId}, shelfItemId=${shelfItemId}, quantity=${quantity}`);

      // Check idempotency
      const idempotencyKey = `expired-${holdId}`;
      try {
        const idempotencyResult = await dynamodbDoc.send(
          new GetCommand({
            TableName: IDEMPOTENCY_TABLE_NAME,
            Key: { id: idempotencyKey },
          })
        );

        if (idempotencyResult.Item) {
          console.log(`Hold expiration ${holdId} already processed, skipping`);
          continue;
        }
      } catch (err) {
        console.warn('Failed to check idempotency, proceeding anyway', { err });
      }

      // Atomically increment quantityAvailable to restore reserved inventory
      const now = new Date().toISOString();
      
      await dynamodbDoc.send(new UpdateCommand({
        TableName: SHELF_ITEMS_TABLE_NAME,
        Key: { shelfItemId },
        UpdateExpression: 'SET quantityAvailable = quantityAvailable + :qty, updatedAt = :now',
        ExpressionAttributeValues: {
          ':qty': quantity,
          ':now': now,
        },
      }));

      console.log(`✅ Successfully restored inventory: shelfItemId=${shelfItemId}, quantity=${quantity}`);

      // Record idempotency
      try {
        const idempotencyTTL = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days (was 24h)
        await dynamodbDoc.send(
          new PutCommand({
            TableName: IDEMPOTENCY_TABLE_NAME,
            Item: {
              id: idempotencyKey,
              processed: true,
              createdAt: now,
              expires_at: idempotencyTTL,
            },
          })
        );
      } catch (err) {
        console.warn('Failed to record idempotency:', err);
      }

    } catch (error) {
      console.error('Error processing expired stock hold event:', error);
      throw error; // Let SQS DLQ handle this after retries
    }
  }

  console.log('========== STOCK HOLD EXPIRED CONSUMER END ==========');
};
