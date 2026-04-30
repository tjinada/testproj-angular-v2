/**
 * Frontend types for the Akamai Flow tab. These mirror the backend's
 * shapes returned by POST /api/akamai/flow (see backend/src/services/
 * akamai.service.ts → EvaluateUrlResult).
 *
 * Kept in sync with the backend manually — the two codebases don't
 * share a types package. When extending, change both.
 */

// ── Request ──────────────────────────────────────────────────────────

export interface AkamaiFlowRequest {
  url: string;
}

// ── Parsed URL (mirrors ParsedRequestUrl in the backend matcher) ────

export interface ParsedRequestUrl {
  hostname: string;
  path: string;
  /** Lowercase, no leading dot. Empty string if the path has no extension. */
  fileExtension: string;
}

// ── Rule entry shape (mirrors AkamaiRuleEntry in the backend) ──────

/**
 * A single behavior or criterion entry inside a rule. Both share the
 * same shape: a name (e.g. "origin", "path", "requestCookie") and an
 * `options` object whose contents vary per name.
 *
 * The frontend treats `options` as opaque — the behavior-detail-panel
 * component renders it as formatted JSON rather than narrowing per
 * behavior type.
 */
export interface AkamaiRuleEntry {
  name: string;
  options: Record<string, unknown>;
}

// ── Matched rule (mirrors MatchedRule in the backend matcher) ───────

/**
 * - "full":    every criterion in the rule was supported and evaluated,
 *              and the rule's criteriaMustSatisfy condition was met.
 * - "partial": the must-satisfy condition was met for criteria we could
 *              evaluate, but at least one criterion was unsupported
 *              (cookies, headers, geo, regex, etc.) so PAPI might decide
 *              differently at runtime.
 */
export type MatchStatus = 'full' | 'partial';

export interface MatchedRule {
  /** Rule names from root to this rule, e.g. ["default", "Separate origins for DPs", "Origin for X"]. */
  rulePath: string[];
  /** Convenience: last element of rulePath. */
  ruleName: string;
  matchStatus: MatchStatus;
  /** Names of criteria that couldn't be evaluated (unsupported type or operator). */
  unevaluatedCriteria: string[];
  /** Names of behaviors defined on this rule (quick chip rendering, no options). */
  behaviorNames: string[];
  /** Full behaviors array — used by the expand-on-click detail view. */
  behaviors: AkamaiRuleEntry[];
  /** Full criteria array. */
  criteria: AkamaiRuleEntry[];
  /** Logical operator between criteria on this rule. "all" = AND, "any" = OR. */
  criteriaMustSatisfy: 'all' | 'any';
}

// ── Baseline (mirrors AkamaiBaseline in the backend extractor) ──────

/**
 * Baseline values pulled from the default (root) rule's behaviors.
 * Every field is optional — PAPI configs vary, and we never fabricate
 * defaults. Missing fields render as "—" (or similar) in the UI.
 */
export interface AkamaiBaseline {
  origin?: {
    hostname?: string;
    forwardHostHeader?: string;
    cacheKeyHostname?: string;
    originType?: string;
    httpPort?: number;
    httpsPort?: number;
  };
  caching?: {
    behavior?: string;
    ttl?: string;
    mustRevalidate?: boolean;
  };
  cpCode?: {
    id?: number;
    name?: string;
  };
}

export interface AkamaiBaselineDiagnostics {
  defaultRuleBehaviorCount: number;
  extractedBehaviorNames: string[];
  /**
   * Behaviors present on the default rule but not pulled into the
   * structured baseline. Useful in the UI as a "the property also
   * defines: X, Y, Z" hint.
   */
  unextractedBehaviorNames: string[];
}

// ── Property identifier (returned with every flow result) ───────────

export interface AkamaiPropertySummary {
  propertyId: string;
  propertyName: string;
  version: number;
}

// ── Top-level success response from POST /api/akamai/flow ───────────

export interface AkamaiFlowResult {
  url: string;
  parsedUrl: ParsedRequestUrl;
  property: AkamaiPropertySummary;
  baseline: AkamaiBaseline;
  baselineDiagnostics: AkamaiBaselineDiagnostics;
  matchedRules: MatchedRule[];
  matchedRuleCount: number;
}

// ── Error response shapes ───────────────────────────────────────────

/**
 * Returned with status 404 when the input URL's hostname is not on any
 * monitored property. Includes a sample of configured hostnames so the
 * UI can show "did you mean one of these?" hints.
 */
export interface AkamaiFlowHostnameError {
  error: string;
  url: string;
  parsedUrl: ParsedRequestUrl;
  configuredHostnameCount: number;
  configuredHostnamesSample: string[];
}

/**
 * Returned with status 400 when the input URL is missing or malformed.
 */
export interface AkamaiFlowParseError {
  error: string;
  url?: string;
}

/**
 * Generic 500 from the backend. Used for unexpected failures (PAPI
 * outage, library bugs, etc.).
 */
export interface AkamaiFlowGenericError {
  error: string;
}

/**
 * Discriminated by HTTP status at the call site:
 *   - 400 → AkamaiFlowParseError
 *   - 404 → AkamaiFlowHostnameError
 *   - 500 → AkamaiFlowGenericError
 *
 * The component reads `error.status` from the HttpErrorResponse and
 * narrows accordingly.
 */
export type AkamaiFlowError =
  | AkamaiFlowParseError
  | AkamaiFlowHostnameError
  | AkamaiFlowGenericError;

/**
 * Type guard for the 404-shaped error body. Useful in the component
 * when deciding whether to render the "configured hostnames" hint.
 */
export function isHostnameError(body: AkamaiFlowError): body is AkamaiFlowHostnameError {
  return (
    typeof (body as AkamaiFlowHostnameError).configuredHostnamesSample !== 'undefined'
  );
}
