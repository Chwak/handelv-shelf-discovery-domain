/** EventBridge detail envelope — see shared-infra/SCHEMA_REGISTRY.txt */

export function resolveEventBridgeBusinessPayload<T extends object>(detail: unknown): T {
  if (!detail || typeof detail !== "object") {
    throw new Error("Missing EventBridge detail");
  }
  const envelope = detail as Record<string, unknown>;
  const payload = envelope.payload;
  if (payload !== undefined && typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as T;
  }
  return envelope as T;
}
