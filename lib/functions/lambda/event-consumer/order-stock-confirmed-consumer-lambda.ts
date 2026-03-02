import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { initTelemetryLogger } from '../../../utils/telemetry-logger';

const SHELF_ITEMS_TABLE_NAME = process.env.SHELF_ITEMS_TABLE_NAME || '';
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME || '';

interface StockHold {
  holdId: string;
  orderId: string;
  shelfItemId: string;
  quantity: number;
  makerUserId: string;
  collectorUserId: string;
  status: string;
}

interface OrderStockConfirmedEvent {
  orderId: string;
  paymentId: string;
  holds: StockHold[];
  timestamp: string;
}

const dynamodbClient = new DynamoDBClient({});
const dynamodbDoc = DynamoDBDocumentClient.from(dynamodbClient);

export const handler = async (event: SQSEvent): Promise<{
  batchItemFailures: Array<{ itemIdentifier: string }>;
}> => {
  initTelemetryLogger(event, { domain: 'shelf-discovery-domain', service: 'order-stock-confirmed-consumer' });
  
  console.log('========== ORDER STOCK CONFIRMED CONSUMER START (Shelf-Discovery Domain) ==========');

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


      const detail = eventBridgeEnvelope.detail as OrderStockConfirmedEvent;
      if (!detail) {
        throw new Error('Missing detail in EventBridge envelope');
      }

      const { orderId, paymentId, holds } = detail;

      // Validate required fields
      if (!orderId || !paymentId || !holds || holds.length === 0) {
        throw new Error(
          `Missing required fields: orderId=${orderId}, paymentId=${paymentId}, holds=${holds?.length || 0}`
        );
      }

      console.log('Order Stock Confirmed Event:', { orderId, holdCount: holds.length });

      // Check idempotency
      const idempotencyKey = orderId;
      try {
        const idempotencyResult = await dynamodbDoc.send(
          new GetCommand({
            TableName: IDEMPOTENCY_TABLE_NAME,
            Key: { id: idempotencyKey },
          })
        );

        if (idempotencyResult.Item) {
          console.log(`Order stock already confirmed for orderId=${orderId}, skipping`);
          continue;
        }
      } catch (err) {
        console.warn('Failed to check idempotency, proceeding anyway', { err });
      }

      // Process each hold: increment quantitySold
      for (const hold of holds) {
        const { shelfItemId, quantity } = hold;

        console.log(`Processing hold: shelfItemId=${shelfItemId}, quantity=${quantity}`);

        // NOTE: quantityAvailable was already decremented when the hold was created
        // We only need to increment quantitySold here (public sales counter)
        const now = new Date().toISOString();

        await dynamodbDoc.send(
          new UpdateCommand({
            TableName: SHELF_ITEMS_TABLE_NAME,
            Key: { shelfItemId },
            UpdateExpression: 'SET quantitySold = quantitySold + :qty, updatedAt = :now',
            ExpressionAttributeValues: {
              ':qty': quantity,
              ':now': now,
            },
          })
        );

        console.log(`✅ Sale confirmed: shelfItemId=${shelfItemId}, quantitySold +${quantity}`);
      }

      // Record idempotency
      try {
        const idempotencyTTL = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days (was 24h)
        const now = new Date().toISOString();
        
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

      console.log(`✅ Order stock confirmed: orderId=${orderId}, paymentId=${paymentId}`);
    } catch (err) {
      console.error(`❌ Error processing record ${messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId || messageId });
    }
  }

  console.log('========== ORDER STOCK CONFIRMED CONSUMER END ==========');
  return { batchItemFailures };
};
