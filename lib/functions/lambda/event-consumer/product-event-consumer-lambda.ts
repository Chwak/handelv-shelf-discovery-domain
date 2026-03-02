import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GlueClient, GetSchemaVersionCommand } from '@aws-sdk/client-glue';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { initTelemetryLogger } from '../../../utils/telemetry-logger';

const SHELF_ITEMS_TABLE_NAME = process.env.SHELF_ITEMS_TABLE_NAME || '';
const SOLD_OUT_ITEMS_TABLE_NAME = process.env.SOLD_OUT_ITEMS_TABLE_NAME || '';
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME || '';
const SCHEMA_REGISTRY_NAME = process.env.SCHEMA_REGISTRY_NAME || '';
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60; // ✅ CRITICAL FIX: Extended to 7 days (was 24h)

const glueClient = new GlueClient({});
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemaValidators = new Map<string, ValidateFunction>();

interface SqsRecord {
  body?: string;
  messageId?: string;
  messageAttributes?: Record<string, { stringValue?: string } | undefined>;
}

interface EventBridgeEnvelope {
  detail?: {
    eventId?: string;
    correlationId?: string;
    eventType?: string;
    eventVersion?: number;
    payload?: string | ProductShelfEvent;
    metadata?: {
      traceparent?: string;
      trace_id?: string;
      span_id?: string;
    };
  };
}

interface ProductShelfEvent {
  event?: string;
  productId?: string;
  makerUserId?: string;
  title?: string;
  description?: string;
  categoryId?: string;
  basePrice?: number;
  quantityAvailable?: number;
  previousStatus?: string;
  updatedAt?: string;
}

/**
 * Product Event Consumer Lambda - Discovery Domain
 * 
 * Listens to events from Product Domain:
 * - product.shelf.item.published.v1 → Create shelf item
 * - product.shelf.item.updated.v1 → Update shelf item
 * - product.shelf.item.removed.v1 → Delete shelf item
 * 
 * Maintains denormalized shelf_items table for search optimization
 */
export const handler = async (
  event: { Records?: SqsRecord[] }
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "product-event-consumer" });
  console.log('========== PRODUCT EVENT CONSUMER START (Discovery Domain) ==========');

  if (!SHELF_ITEMS_TABLE_NAME) {
    console.error('SHELF_ITEMS_TABLE_NAME not set');
    throw new Error('Internal server error');
  }

  if (!SOLD_OUT_ITEMS_TABLE_NAME) {
    console.error('SOLD_OUT_ITEMS_TABLE_NAME not set');
    throw new Error('Internal server error');
  }

  if (!IDEMPOTENCY_TABLE_NAME) {
    console.error('IDEMPOTENCY_TABLE_NAME not set');
    throw new Error('Internal server error');
  }

  if (!SCHEMA_REGISTRY_NAME) {
    console.error('SCHEMA_REGISTRY_NAME not set');
    throw new Error('Schema registry not configured');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records || []) {
    const recordId = record.messageId || 'unknown';
    try {
      console.log('---------- Processing Record ----------');

      const body = record.body;
      if (!body) {
        console.log('No body found in record, skipping');
        continue;
      }

      let payload: ProductShelfEvent;
      let eventId: string | undefined;
      let eventType: string | undefined;
      let traceparent: string | undefined;

      // Parse EventBridge event from SQS
      try {
        const parsed = JSON.parse(body) as EventBridgeEnvelope;

        if (parsed.detail && typeof parsed.detail === 'object') {
          // Validate event schema
          if (parsed.detail.eventType) {
            await validateEventDetail(parsed.detail.eventType, parsed.detail);
          }

          eventType = parsed.detail.eventType;
          eventId = parsed.detail.eventId || parsed.detail.correlationId;
          traceparent = parsed.detail.metadata?.traceparent;

          const detailPayload = parsed.detail.payload;
          if (typeof detailPayload === 'string') {
            payload = JSON.parse(detailPayload) as ProductShelfEvent;
          } else if (detailPayload && typeof detailPayload === 'object') {
            payload = detailPayload as ProductShelfEvent;
          } else {
            throw new Error('Invalid EventBridge detail payload');
          }
        } else {
          throw new Error('Invalid EventBridge envelope structure');
        }
      } catch (e) {
        console.error('Failed to parse EventBridge message; sending to DLQ', { recordId, err: e });
        throw e;
      }

      console.log('Event type:', eventType);

      // Check idempotency
      const idempotencyKey = eventId || traceparent || `${payload.productId}:${payload.event}`;
      if (!(await acquireIdempotencyLock(client, idempotencyKey))) {
        console.log('Duplicate event detected; skipping', { idempotencyKey });
        continue;
      }

      // Route to appropriate handler based on event type
      switch (eventType) {
        case 'product.shelf.item.published.v1':
          await handleProductPublished(client, payload);
          break;

        case 'product.shelf.item.updated.v1':
          await handleProductUpdated(client, payload);
          break;

        case 'product.shelf.item.removed.v1':
          await handleProductRemoved(client, payload);
          break;

        default:
          console.warn('Unknown event type, ignoring', { eventType });
      }

      await markIdempotencyComplete(client, idempotencyKey);
      console.log('Successfully processed event', { eventType, recordId });

    } catch (err) {
      console.error('Failed to process record', { recordId, err });
      if (record.messageId) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
  }

  return { batchItemFailures };
};

/**
 * Handle product.shelf.item.published.v1
 * Creates a new shelf item in the Discovery domain
 */
async function handleProductPublished(client: DynamoDBDocumentClient, payload: ProductShelfEvent): Promise<void> {
  const shelfItemId = payload.productId;
  if (!shelfItemId || !payload.makerUserId) {
    throw new Error('Missing required fields: productId or makerUserId');
  }

  const now = new Date().toISOString();
  const shelfItem = {
    shelfItemId,
    makerUserId: payload.makerUserId,
    title: payload.title || 'Untitled Product',
    description: payload.description || '',
    categoryId: payload.categoryId || 'uncategorized',
    basePrice: payload.basePrice || 0,
    quantityAvailable: payload.quantityAvailable || 0,
    
    // Search & ranking signals (initialized)
    rating: 0,
    viewCount: 0,
    saveCount: 0,
    orderCount: 0,
    relevanceScore: 1.0,
    
    // Status tracking
    shelfStatus: 'ACTIVE', // For GSI filtering
    isSoldOut: (payload.quantityAvailable || 0) === 0,
    
    // Timestamps
    publishedAt: payload.updatedAt || now,
    lastUpdatedAt: now,
    createdAt: now,
    
    // ✅ CRITICAL FIX: Optimistic locking fields
    version: 1,
    eventTimestamp: payload.updatedAt || now,
  };

  console.log('Creating shelf item:', JSON.stringify(shelfItem, null, 2));

  await client.send(
    new PutCommand({
      TableName: SHELF_ITEMS_TABLE_NAME,
      Item: shelfItem,
    })
  );

  console.log('Shelf item created successfully', { shelfItemId });
}

/**
 * Handle product.shelf.item.updated.v1
 * Updates an existing shelf item with new product details
 */
async function handleProductUpdated(client: DynamoDBDocumentClient, payload: ProductShelfEvent): Promise<void> {
  const shelfItemId = payload.productId;
  if (!shelfItemId) {
    throw new Error('Missing required field: productId');
  }

  const now = new Date().toISOString();
  const eventTimestamp = payload.updatedAt || now;
  const updates: string[] = ['lastUpdatedAt = :now', '#version = #version + :inc', 'eventTimestamp = :eventTime'];
  const values: Record<string, any> = { ':now': now, ':inc': 1, ':eventTime': eventTimestamp };
  const names: Record<string, string> = { '#version': 'version' };

  // Update fields that changed
  if (payload.title !== undefined) {
    updates.push('#title = :title');
    names['#title'] = 'title';
    values[':title'] = payload.title;
  }

  if (payload.description !== undefined) {
    updates.push('#description = :desc');
    names['#description'] = 'description';
    values[':desc'] = payload.description;
  }

  if (payload.categoryId !== undefined) {
    updates.push('categoryId = :cat');
    values[':cat'] = payload.categoryId;
  }

  if (payload.basePrice !== undefined) {
    updates.push('basePrice = :price');
    values[':price'] = payload.basePrice;
  }

  if (payload.quantityAvailable !== undefined) {
    updates.push('quantityAvailable = :qty, isSoldOut = :soldOut');
    values[':qty'] = payload.quantityAvailable;
    values[':soldOut'] = payload.quantityAvailable === 0;
  }

  console.log('Updating shelf item:', { shelfItemId, updates });

  // ✅ CRITICAL FIX: Get current item to check version and prevent out-of-order updates
  const currentItemResult = await client.send(
    new GetCommand({
      TableName: SHELF_ITEMS_TABLE_NAME,
      Key: { shelfItemId },
    })
  );
  const currentItem = currentItemResult.Item as Record<string, any> | undefined;
  
  if (!currentItem) {
    console.warn('Shelf item not found - may have been removed', { shelfItemId });
    return; // Item doesn't exist, skip update
  }
  
  const currentVersion = currentItem.version || 0;
  const currentEventTimestamp = currentItem.eventTimestamp || '1970-01-01T00:00:00Z';
  
  // Check if this event is older than what we already processed
  if (eventTimestamp <= currentEventTimestamp) {
    console.warn('⚠️ Out-of-order event detected - skipping update', { 
      shelfItemId, 
      currentEventTimestamp, 
      incomingEventTimestamp: eventTimestamp 
    });
    return; // Skip stale event
  }
  
  const wasAvailable = (currentItem?.quantityAvailable ?? 0) > 0;
  const becomesSoldOut = (payload.quantityAvailable ?? (currentItem?.quantityAvailable ?? 0)) === 0;

  // Add condition values for optimistic locking
  values[':currentVersion'] = currentVersion;
  
  try {
    await client.send(
      new UpdateCommand({
        TableName: SHELF_ITEMS_TABLE_NAME,
        Key: { shelfItemId },
        UpdateExpression: 'SET ' + updates.join(', '),
        ConditionExpression: '#version = :currentVersion', // ✅ CRITICAL FIX: Optimistic lock
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    if ((err as any).name === 'ConditionalCheckFailedException') {
      console.warn('⚠️ Concurrent update detected - version mismatch', { 
        shelfItemId, 
        expectedVersion: currentVersion 
      });
      throw new Error('Concurrent modification detected - will retry');
    }
    throw err;
  }

  // If item just sold out (qty was > 0, now = 0), move to sold-out table
  if (wasAvailable && becomesSoldOut) {
    console.log('Item sold out, moving to sold-out table:', { shelfItemId });
    
    // Get full item to copy to sold-out table
    const updatedItemResult = await client.send(
      new GetCommand({
        TableName: SHELF_ITEMS_TABLE_NAME,
        Key: { shelfItemId },
      })
    );
    const soldOutItem = updatedItemResult.Item as Record<string, any> | undefined;
    
    if (soldOutItem) {
      const soldOutAt = now;
      const expectedVersion = currentVersion + 1; // Version we just set in the update
      const expectedTimestamp = soldOutItem.eventTimestamp || eventTimestamp;
      
      // ✅ CRITICAL: Verify item is still sold out (qty = 0) before archiving
      if ((soldOutItem.quantityAvailable ?? 0) !== 0) {
        console.warn('⚠️ Item was restocked after sold-out detected - skipping archive', {
          shelfItemId,
          currentQty: soldOutItem.quantityAvailable,
        });
        return; // Item restocked by newer event, don't archive
      }
      
      // Move to sold-out table
      await client.send(
        new PutCommand({
          TableName: SOLD_OUT_ITEMS_TABLE_NAME,
          Item: {
            ...soldOutItem,
            soldOutAt,
            archivedAt: now,
          },
        })
      );

      // ✅ CRITICAL FIX: Conditional delete to prevent out-of-order removal
      try {
        await client.send(
          new DeleteCommand({
            TableName: SHELF_ITEMS_TABLE_NAME,
            Key: { shelfItemId },
            ConditionExpression: '#version = :expectedVersion AND eventTimestamp = :expectedTimestamp',
            ExpressionAttributeNames: {
              '#version': 'version',
            },
            ExpressionAttributeValues: {
              ':expectedVersion': expectedVersion,
              ':expectedTimestamp': expectedTimestamp,
            },
          })
        );
        console.log('✅ Item moved to sold-out table and removed from shelf:', { shelfItemId, soldOutAt });
      } catch (err) {
        if ((err as any).name === 'ConditionalCheckFailedException') {
          console.warn('⚠️ Item was updated concurrently - sold-out delete skipped', {
            shelfItemId,
            expectedVersion,
          });
          // Item was updated by newer event, which is correct behavior
          return;
        }
        throw err;
      }
    }
  }

  console.log('Shelf item updated successfully', { shelfItemId });
}

/**
 * Handle product.shelf.item.removed.v1
 * Deletes a shelf item when product moves off the shelf (to basement)
 */
/**
 * Handle product.shelf.item.removed.v1
 * Removes a shelf item from the Discovery domain
 * ✅ CRITICAL FIX: Added out-of-order protection and conditional delete
 */
async function handleProductRemoved(client: DynamoDBDocumentClient, payload: ProductShelfEvent): Promise<void> {
  const shelfItemId = payload.productId;
  if (!shelfItemId) {
    throw new Error('Missing required field: productId');
  }

  const eventTimestamp = payload.updatedAt || new Date().toISOString();

  console.log('Removing shelf item:', { shelfItemId, eventTimestamp });

  // ✅ CRITICAL FIX: Check item exists and event is not stale before deleting
  const currentItemResult = await client.send(
    new GetCommand({
      TableName: SHELF_ITEMS_TABLE_NAME,
      Key: { shelfItemId },
    })
  );

  if (!currentItemResult.Item) {
    console.log('Shelf item already removed or never existed', { shelfItemId });
    return; // Idempotent - already gone
  }

  const currentItem = currentItemResult.Item;
  const currentEventTimestamp = currentItem.eventTimestamp || '1970-01-01T00:00:00Z';

  // Check if this remove event is older than what we already have
  if (eventTimestamp < currentEventTimestamp) {
    console.warn('⚠️ Out-of-order remove event - item has newer data, skipping delete', {
      shelfItemId,
      removeEventTimestamp: eventTimestamp,
      currentEventTimestamp,
    });
    return; // Don't delete if we have newer data
  }

  // Perform conditional delete with timestamp check
  try {
    await client.send(
      new DeleteCommand({
        TableName: SHELF_ITEMS_TABLE_NAME,
        Key: { shelfItemId },
        ConditionExpression: 'eventTimestamp = :expectedTimestamp', // ✅ Only delete if unchanged
        ExpressionAttributeValues: {
          ':expectedTimestamp': currentEventTimestamp,
        },
      })
    );
    console.log('✅ Shelf item removed successfully', { shelfItemId });
  } catch (err) {
    if ((err as any).name === 'ConditionalCheckFailedException') {
      console.warn('⚠️ Shelf item was updated concurrently - skipping delete', { shelfItemId });
      // Item was updated by another lambda, don't delete
      return;
    }
    throw err;
  }
}

/**
 * Acquire idempotency lock to prevent duplicate event processing
 */
async function acquireIdempotencyLock(client: DynamoDBDocumentClient, idempotencyKey: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + IDEMPOTENCY_TTL_SECONDS;

  try {
    await client.send(
      new PutCommand({
        TableName: IDEMPOTENCY_TABLE_NAME,
        Item: {
          id: idempotencyKey,
          status: 'PROCESSING',
          created_at: now,
          expires_at: expiresAt,
        },
        ConditionExpression: 'attribute_not_exists(id)',
      })
    );
    return true;
  } catch (err) {
    if ((err as any).name === 'ConditionalCheckFailedException') {
      return false; // Already processing or processed
    }
    throw err;
  }
}

/**
 * Mark idempotency processing as complete
 */
async function markIdempotencyComplete(client: DynamoDBDocumentClient, idempotencyKey: string): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: IDEMPOTENCY_TABLE_NAME,
      Key: { id: idempotencyKey },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'COMPLETE' },
    })
  );
}

/**
 * Validate event payload against Glue Schema Registry
 * ✅ CRITICAL FIX: Schema validation is now fatal - invalid events will be rejected
 */
async function validateEventDetail(eventType: string, detail: any): Promise<void> {
  try {
    const validator = await getSchemaValidator(eventType);
    const valid = validator(detail);
    if (!valid) {
      const errors = validator.errors?.map(e => `${e.instancePath} ${e.message}`).join('; ') || 'Unknown validation error';
      console.error('❌ Event validation FAILED - rejecting event', { eventType, errors: validator.errors });
      throw new Error(`Schema validation failed for ${eventType}: ${errors}`);
    }
    console.log('✅ Event schema validation passed', { eventType });
  } catch (err) {
    if ((err as Error).message?.includes('Schema validation failed')) {
      // Re-throw validation errors
      throw err;
    }
    console.error('❌ Schema validation error - rejecting event', { eventType, err });
    throw new Error(`Schema validation error for ${eventType}: ${(err as Error).message}`);
  }
}

async function getSchemaValidator(eventType: string): Promise<ValidateFunction> {
  const cached = schemaValidators.get(eventType);
  if (cached) return cached;

  const schemaVersion = await glueClient.send(
    new GetSchemaVersionCommand({
      SchemaId: {
        RegistryName: SCHEMA_REGISTRY_NAME,
        SchemaName: eventType,
      },
      SchemaVersionNumber: { LatestVersion: true },
    })
  );

  if (!schemaVersion.SchemaDefinition) {
    throw new Error(`Schema not found: ${eventType}`);
  }

  const schemaObj = JSON.parse(schemaVersion.SchemaDefinition);
  const validator = ajv.compile(schemaObj);
  schemaValidators.set(eventType, validator);
  return validator;
}
