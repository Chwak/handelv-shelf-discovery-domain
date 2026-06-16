/**
 * Active-mode resolution + HTTP API claim extraction for this domain only (no monorepo package dependency).
 * Align with `handelv-backend/hand-made-active-mode/ACTIVE_MODE_POLICY.txt` when platform rules change.
 */

export type ActiveMode = "maker" | "collector";
/** `both` = resolved maker or collector role required; `authenticated` = valid JWT subject only (no capability check). */
export type RequiredMode = ActiveMode | "both" | "authenticated";

/** When both capability flags are true and `active_mode` is absent, pick this persona for effective mode. */
export type DualRoleAmbiguousDefault = "maker" | "collector";

/** AppSync / maker-primary domains (orders, products, maker profile, etc.) */
export const PLATFORM_DUAL_ROLE_DEFAULT_GRAPHQL: DualRoleAmbiguousDefault = "maker";

/** Collector-primary HTTP and collector GraphQL domains */
export const PLATFORM_DUAL_ROLE_DEFAULT_COLLECTOR_FACING: DualRoleAmbiguousDefault = "collector";

function isEnabled(value: unknown): boolean {
  return value === true || value === "true";
}

export function resolveEffectiveActiveMode(
  claims: Record<string, unknown> | undefined,
  whenBothEnabledAmbiguous: DualRoleAmbiguousDefault,
): ActiveMode | null {
  if (!claims) return null;

  const rawMode = claims.active_mode;
  if (rawMode === "maker" || rawMode === "collector") {
    return rawMode;
  }

  const makerEnabled = isEnabled(claims.maker_enabled);
  const collectorEnabled = isEnabled(claims.collector_enabled);

  if (makerEnabled !== collectorEnabled) {
    return makerEnabled ? "maker" : "collector";
  }

  if (makerEnabled && collectorEnabled) {
    return whenBothEnabledAmbiguous;
  }

  return null;
}

export function isAuthorizedForMode(
  claims: Record<string, unknown> | undefined,
  required: RequiredMode,
  whenBothEnabledAmbiguous: DualRoleAmbiguousDefault,
): boolean {
  if (required === "authenticated") {
    const sub = claims?.sub;
    return typeof sub === "string" && sub.trim().length > 0;
  }
  // Capability-based authorization — gate on ENTITLEMENT, not the mutable
  // `active_mode` UI state. An entitled user may call an experience's APIs
  // regardless of which experience is currently "active" in the UI.
  // See EXPERIENCE_AUTH_REDESIGN.md.
  void whenBothEnabledAmbiguous; // retained for signature back-compat
  const makerEnabled = isEnabled(claims?.maker_enabled);
  const collectorEnabled = isEnabled(claims?.collector_enabled);
  if (required === "both") {
    return makerEnabled || collectorEnabled;
  }
  return required === "maker" ? makerEnabled : collectorEnabled;
}

export function getAuthenticatedSub(event: {
  identity?: { sub?: string; claims?: { sub?: string } };
}): string | null {
  const identity = event?.identity;
  if (!identity) return null;
  if (typeof identity.sub === "string" && identity.sub.trim()) {
    return identity.sub.trim();
  }
  const claimSub = identity.claims?.sub;
  if (typeof claimSub === "string" && claimSub.trim()) {
    return claimSub.trim();
  }
  return null;
}

/**
 * Normalize HTTP API (API Gateway v2) authorizer payloads: claim maps may appear under
 * `requestContext.authorizer.claims` (Lambda/Cognito authorizer) or `requestContext.authorizer.jwt.claims`
 * (HTTP API built-in JWT authorizer). See `platform-test-fixtures/LOCAL_EVENT_FIDELITY.txt` in repo root package.
 */
export function getClaimsFromHttpApiAuthorizer(authorizer: unknown): Record<string, unknown> | undefined {
  if (!authorizer || typeof authorizer !== "object") return undefined;
  const a = authorizer as Record<string, unknown>;
  const jwt = a.jwt;
  if (jwt && typeof jwt === "object") {
    const inner = jwt as Record<string, unknown>;
    const c = inner.claims;
    if (c && typeof c === "object") return c as Record<string, unknown>;
  }
  const claims = a.claims;
  if (claims && typeof claims === "object") return claims as Record<string, unknown>;
  return undefined;
}

export function getClaimsFromHttpApiEvent(event: {
  requestContext?: { authorizer?: unknown; identity?: unknown };
}): Record<string, unknown> | undefined {
  const fromAuthorizer = getClaimsFromHttpApiAuthorizer(event.requestContext?.authorizer);
  if (fromAuthorizer) return fromAuthorizer;
  const id = event.requestContext?.identity;
  if (id && typeof id === "object") return id as Record<string, unknown>;
  return undefined;
}

export function requireAuthenticatedUser(
  event: { identity?: { sub?: string; claims?: { sub?: string } } },
  requiredMode: RequiredMode,
  whenBothEnabledAmbiguous: DualRoleAmbiguousDefault,
): string | null {
  const identity = event?.identity;
  if (!identity) return null;
  if (requiredMode === "authenticated") {
    return getAuthenticatedSub(event);
  }
  const claims = identity.claims as Record<string, unknown> | undefined;
  if (!isAuthorizedForMode(claims, requiredMode, whenBothEnabledAmbiguous)) {
    return null;
  }
  return getAuthenticatedSub(event);
}
