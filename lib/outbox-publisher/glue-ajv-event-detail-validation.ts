// SYNC: keep identical to handelv-backend/lib/event-schema/glue-ajv-event-detail-validation.ts

import { GetSchemaVersionCommand, type GlueClient } from '@aws-sdk/client-glue';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedValidator {
  validate: ValidateFunction;
  cachedAt: number;
}

export function createGlueAjvEventDetailValidator(options: {
  glueClient: GlueClient;
  schemaRegistryName: string;
  ajv: InstanceType<typeof Ajv>;
}): { validateEventDetail: (eventType: string, detail: unknown) => Promise<void> } {
  const schemaValidators = new Map<string, CachedValidator>();
  const { glueClient, schemaRegistryName, ajv } = options;

  async function getSchemaValidator(eventType: string, bypassCache: boolean): Promise<ValidateFunction> {
    if (!bypassCache) {
      const cached = schemaValidators.get(eventType);
      if (cached && Date.now() - cached.cachedAt < SCHEMA_CACHE_TTL_MS) {
        return cached.validate;
      }
    }

    const schemaVersion = await glueClient.send(
      new GetSchemaVersionCommand({
        SchemaId: {
          RegistryName: schemaRegistryName,
          SchemaName: eventType,
        },
        SchemaVersionNumber: { LatestVersion: true },
      }),
    );

    if (!schemaVersion.SchemaDefinition) {
      throw new Error(`No schema definition found for ${eventType}`);
    }

    const schema = JSON.parse(schemaVersion.SchemaDefinition) as object;
    const validate = ajv.compile(schema);
    schemaValidators.set(eventType, { validate, cachedAt: Date.now() });
    return validate;
  }

  async function validateEventDetail(eventType: string, detail: unknown): Promise<void> {
    let validate = await getSchemaValidator(eventType, false);
    if (validate(detail)) return;

    schemaValidators.delete(eventType);
    validate = await getSchemaValidator(eventType, true);
    const valid = validate(detail);
    if (!valid) {
      const errors =
        validate.errors?.map((err: { instancePath?: string; message?: string }) => `${err.instancePath} ${err.message}`) ||
        [];
      throw new Error(`Schema validation failed for ${eventType}: ${errors.join('; ')}`);
    }
  }

  return { validateEventDetail };
}

const defaultAjv = new Ajv({ allErrors: true, strict: false });
const validatorByRegistry = new Map<
  string,
  { validateEventDetail: (eventType: string, detail: unknown) => Promise<void> }
>();

export async function validateEventDetail(
  glueClient: GlueClient,
  schemaRegistryName: string,
  eventType: string,
  detail: unknown,
): Promise<void> {
  if (!schemaRegistryName?.trim()) {
    throw new Error('SCHEMA_REGISTRY_NAME not configured');
  }
  let validator = validatorByRegistry.get(schemaRegistryName);
  if (!validator) {
    validator = createGlueAjvEventDetailValidator({
      glueClient,
      schemaRegistryName,
      ajv: defaultAjv,
    });
    validatorByRegistry.set(schemaRegistryName, validator);
  }
  await validator.validateEventDetail(eventType, detail);
}
