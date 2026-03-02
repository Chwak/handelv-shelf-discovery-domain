import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import { requireAuthenticatedUser } from '../../../../utils/validation-utils';
/**
 * Collector's Assistant: interpret natural language into structured search filters.
 * Uses Bedrock (Titan) - no OpenSearch. Source for interpret-collector-query-lambda.js.
 * Build: npx esbuild interpret-collector-query-lambda.ts --outfile=interpret-collector-query-lambda.js --platform=node --format=cjs
 */
'use strict';

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const REGION = process.env.REGION_CODE || process.env.AWS_REGION || 'us-east-1';
const MODEL_ID = 'amazon.titan-text-express-v1';
const MAX_TOKENS = 512;

const SYSTEM_PROMPT = `You are a Collector's Assistant for a handmade crafts marketplace. Given a natural language request, output ONLY a single JSON object (no markdown, no explanation) with these optional fields:
- query: string - A short search phrase (keywords) for matching products (e.g. "hand-woven rug Siwa Oasis minimalist Scandinavian"). Use 3-15 words max. Omit if the request is too vague.
- categoryId: string - One of: ceramics, furniture, textiles, jewelry, art. Omit if not inferrable.
- minPrice: number - Minimum price in USD, or omit.
- maxPrice: number - Maximum price in USD, or omit.
- materials: array of strings - e.g. ["wool", "cotton"]. Omit if not mentioned.
- summary: string - One short sentence describing what the collector is looking for, for display (e.g. "Hand-woven rugs from Siwa Oasis for a minimalist Scandinavian interior").

If the user message is empty or not a search intent, return {"query":null,"summary":"No specific criteria"}.
Output ONLY valid JSON.`;

function buildPrompt(naturalLanguageQuery: string | undefined): string {
  const q = (naturalLanguageQuery || '').trim();
  if (!q) {
    return JSON.stringify({ query: null, summary: 'No specific criteria' });
  }
  return `${SYSTEM_PROMPT}\n\nUser request: ${q}\n\nJSON:`;
}

function parseJsonFromResponse(text: string | undefined): Record<string, unknown> | null {
  const trimmed = (text || '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}') + 1;
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end));
  } catch {
    return null;
  }
}

function sanitizeOutput(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') {
    return { query: null, summary: 'No specific criteria' };
  }
  const o = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {
    query: typeof o.query === 'string' ? o.query.trim().slice(0, 200) : null,
    categoryId: typeof o.categoryId === 'string' ? o.categoryId.trim().slice(0, 50) : null,
    minPrice: typeof o.minPrice === 'number' && o.minPrice >= 0 ? o.minPrice : null,
    maxPrice: typeof o.maxPrice === 'number' && o.maxPrice >= 0 ? o.maxPrice : null,
    materials: Array.isArray(o.materials)
      ? (o.materials as string[]).filter((m: string) => typeof m === 'string').map((m: string) => m.trim().slice(0, 100)).slice(0, 20)
      : null,
    summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 300) : null,
  };
  if (!out.summary && out.query) out.summary = out.query;
  return out;
}

async function invokeBedrock(client: unknown, prompt: string): Promise<Record<string, unknown> | null> {
  const body = {
    inputText: prompt,
    textGenerationConfig: { maxTokenCount: MAX_TOKENS, temperature: 0.2, topP: 0.9, stopSequences: [] },
  };
  const response = await (client as { send: (cmd: unknown) => Promise<{ body?: Uint8Array }> }).send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  }));
  const decoded = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(decoded);
  const outputText = parsed.results?.[0]?.outputText;
  return outputText ? parseJsonFromResponse(outputText) : null;
}

exports.handler = async (event: { arguments?: { naturalLanguageQuery?: unknown }; identity?: { sub?: string; claims?: { sub?: string } } }) => {
  const args = event.arguments || {};
  const authUserId = requireAuthenticatedUser(event);
  if (!authUserId) {
    throw new Error('Not authenticated');
  }
  const naturalLanguageQuery = typeof args.naturalLanguageQuery === 'string' ? args.naturalLanguageQuery : '';

  if (!naturalLanguageQuery.trim()) {
    return sanitizeOutput({ query: null, summary: 'No specific criteria' });
  }
  const prompt = buildPrompt(naturalLanguageQuery);
  try {
    const client = new BedrockRuntimeClient({ region: REGION });
    let parsed = await invokeBedrock(client, prompt);
    if (!parsed) {
      parsed = { query: naturalLanguageQuery.trim().slice(0, 200), summary: naturalLanguageQuery.trim().slice(0, 300) };
    }
    return sanitizeOutput(parsed);
  } catch (err) {
    console.error('InterpretCollectorQuery error:', err);
    return sanitizeOutput({
      query: naturalLanguageQuery.trim().slice(0, 200),
      summary: naturalLanguageQuery.trim().slice(0, 300),
    });
  }
};