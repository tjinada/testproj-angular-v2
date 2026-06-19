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
 */
export interface AkamaiRuleEntry {
  name: string;
  options: Record<string, unknown>;
}

// ── Matched rule (mirrors MatchedRule in the backend matcher) ───────

export type MatchStatus = 'full' | 'partial';

export interface MatchedRule {
  /** Rule names from root to this rule. */
  rulePath: string[];
  /** Convenience: last element of rulePath. */
  ruleName: string;
  matchStatus: MatchStatus;
  /** Names of criteria that couldn't be evaluated (unsupported type or operator). */
  unevaluatedCriteria: string[];
  /** Names of behaviors defined on this rule. */
  behaviorNames: string[];
  /** Full behaviors array — used by the expand-on-click detail view. */
  behaviors: AkamaiRuleEntry[];
  /** Full criteria array. */
  criteria: AkamaiRuleEntry[];
  /** Logical operator between criteria on this rule. "all" = AND, "any" = OR. */
  criteriaMustSatisfy: 'all' | 'any';
}

// ── Rewrite step (mirrors RewriteStep in the backend rewrite resolver) ──

export type RewriteBehaviorKind = 'REWRITE' | 'REPLACE' | 'REMOVE' | 'PREPEND';

export interface RewriteStep {
  rulePath: string[];
  behavior: RewriteBehaviorKind;
  from: string;
  to: string;
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
  /** Final path after applying the matched rewriteUrl behaviors in order. */
  destinationPath: string;
  /** True when destinationPath differs from parsedUrl.path. */
  pathChanged: boolean;
  /** Ordered list of the rewrites that fired, each with from/to. */
  rewriteTrace: RewriteStep[];
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
