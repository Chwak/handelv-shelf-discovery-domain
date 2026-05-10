import { DynamoDBClient, QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand, PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { GlueClient, GetSchemaVersionCommand } from "@aws-sdk/client-glue";
import * as crypto from "crypto";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { initTelemetryLogger } from "../../../utils/telemetry-logger";

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eventBridge = new EventBridgeClient({});
const glueClient = new GlueClient({});
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME || "";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "";
const DOMAIN_NAME = process.env.DOMAIN_NAME || "";
const EVENT_SOURCE = process.env.EVENT_SOURCE || "";
const SCHEMA_REGISTRY_NAME = process.env.SCHEMA_REGISTRY_NAME || "";
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "5", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50", 10);
const PENDING_THRESHOLD_MINUTES = parseInt(process.env.PENDING_THRESHOLD_MINUTES || "2", 10);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemaValidators = new Map<string, ValidateFunction>();

type TraceContext = {
  traceparent: string;
  trace_id: string;
  span_id: string;
};

interface OutboxEvent {
  eventId: string;
  status: string;
  createdAt: string;
  eventName?: string;
  eventType?: string;
  payload: string;
  retries: number;
  eventVersion?: number;
  correlationId?: string;
  traceparent?: string;
  trace_id?: string;
  span_id?: string;
}

function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function buildTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function parseTraceparent(traceparent: string): { trace_id: string; span_id: string } | null {
  const match = /^\d{2}-([0-9a-f]{32})-([0-9a-f]{16})-\d{2}$/i.exec(traceparent);
  if (!match) return null;
  return { trace_id: match[1], span_id: match[2] };
}

function resolveTraceContext(outboxEvent: OutboxEvent): TraceContext {
  const parsed = outboxEvent.traceparent ? parseTraceparent(outboxEvent.traceparent) : null;
  const trace_id = outboxEvent.trace_id || parsed?.trace_id || generateTraceId();
  const span_id = outboxEvent.span_id || parsed?.span_id || generateSpanId();
  const traceparent = outboxEvent.traceparent || buildTraceparent(trace_id, span_id);
  return { traceparent, trace_id, span_id };
}

export const handler = async (...args: unknown[]): Promise<void> => {
  const event = args[0] as unknown;
  initTelemetryLogger(event, { domain: "shelf-discovery-domain", service: "republish" });
  if (!OUTBOX_TABLE_NAME || !EVENT_BUS_NAME || !DOMAIN_NAME) throw new Error("Missing env");
  if (!SCHEMA_REGISTRY_NAME) throw new Error("Schema registry not configured");
  try {
    const threshold = new Date(Date.now() - PENDING_THRESHOLD_MINUTES * 60 * 1000).toISOString();
    const queryResult = await dynamoDb.send(new QueryCommand({
      TableName: OUTBOX_TABLE_NAME,
      IndexName: "GSI-StatusCreatedAt",
      KeyConditionExpression: "#status = :ps AND #ca < :th",
      ExpressionAttributeNames: {"#status": "status", "#ca": "createdAt"},
      ExpressionAttributeValues: {":ps": "PENDING", ":th": threshold},
      Limit: BATCH_SIZE,
    }));
    const events = (queryResult.Items || []) as OutboxEvent[];
    if (events.length === 0) return;
    const putRequests: PutEventsRequestEntry[] = [];
    const eventIds: string[] = [];
    for (const e of events) {
      const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      const eventType = e.eventType || e.eventName;
      if (!eventType) throw new Error("Missing event type");
      const traceContext = resolveTraceContext(e);

      const eventDetail = {
        eventId: e.eventId,
        eventType,
        eventVersion: e.eventVersion ?? 1,
        correlationId: e.correlationId,
        payload,
        metadata: {
          traceparent: traceContext.traceparent,
          trace_id: traceContext.trace_id,
          span_id: traceContext.span_id,
        },
      };

      await validateEventDetail(eventType, eventDetail);

      putRequests.push({
        Source: EVENT_SOURCE,
        DetailType: eventType,
        Detail: JSON.stringify(eventDetail),
        EventBusName: EVENT_BUS_NAME,
        TraceHeader: traceContext.traceparent,
      });
      eventIds.push(e.eventId);
    }
    for (let i = 0; i < putRequests.length; i += 10) {
      const batch = putRequests.slice(i, i + 10);
      const ids = eventIds.slice(i, i + 10);
      const resp = await eventBridge.send(new PutEventsCommand({Entries: batch}));
      for (let j = 0; j < ids.length; j++) {
        const e = resp.Entries?.[j];
        if (!e?.ErrorCode) {
          await markSent(ids[j]);
        } else {
          await incrementRetry(ids[j], e.ErrorCode);
        }
      }
    }
  } catch (err) {
    console.error("Republish error", err);
    throw err;
  }
};

async function markSent(eventId: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  await dynamoDb.send(new UpdateCommand({
    TableName: OUTBOX_TABLE_NAME,
    Key: {eventId},
    UpdateExpression: "SET #s = :sent, #e = :exp",
    ExpressionAttributeNames: {"#s": "status", "#e": "expiresAt"},
    ExpressionAttributeValues: {":sent": "SENT", ":exp": exp},
  }));
}

async function incrementRetry(eventId: string, code: string): Promise<void> {
  try {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    await dynamoDb.send(new UpdateCommand({
      TableName: OUTBOX_TABLE_NAME,
      Key: {eventId},
      UpdateExpression: "SET #r = if_not_exists(#r, :z) + :one, #le = :err, #e = :exp, #s = if(#r >= :max, :failed, #s)",
      ExpressionAttributeNames: {"#r": "retries", "#le": "lastError", "#e": "expiresAt", "#s": "status"},
      ExpressionAttributeValues: {":z": 0, ":one": 1, ":err": `${code} at ${new Date().toISOString()}`, ":exp": exp, ":max": MAX_RETRIES, ":failed": "FAILED"},
    }));
  } catch (e) {
    console.error(`Retry increment failed for ${eventId}`, e);
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
    }),
  );

  if (!schemaVersion.SchemaDefinition) {
    throw new Error(`No schema definition found for ${eventType}`);
  }

  const schema = JSON.parse(schemaVersion.SchemaDefinition);
  const validate = ajv.compile(schema);
  schemaValidators.set(eventType, validate);
  return validate;
}

async function validateEventDetail(eventType: string, detail: unknown): Promise<void> {
  const validate = await getSchemaValidator(eventType);
  const valid = validate(detail);
  if (!valid) {
    const errors = validate.errors?.map((err: { instancePath?: string; message?: string }) => `${err.instancePath} ${err.message}`) || [];
    throw new Error(`Schema validation failed for ${eventType}: ${errors.join('; ')}`);
  }
}
