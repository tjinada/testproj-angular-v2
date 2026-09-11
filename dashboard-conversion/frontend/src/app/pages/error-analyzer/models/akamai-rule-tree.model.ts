/**
 * Types for the Akamai Rules tab.
 *
 * The tab consumes a PAPI rule tree JSON (the "default" rule export from
 * Property Manager) and evaluates a request against it entirely in the
 * browser. Nothing here talks to a backend.
 *
 * `AkamaiRuleEntry` and `MatchStatus` are reused from akamai.model.ts —
 * a criterion or behavior has the same {name, options} shape whether it
 * arrives from PAPI directly or via the backend flow endpoint.
 */

import { AkamaiRuleEntry, MatchStatus } from './akamai.model';

// Re-exported so consumers import one model file. `export type` is required
// under isolatedModules, which the Angular CLI enables.
export type { AkamaiRuleEntry, MatchStatus };

// ── Raw PAPI shapes ──────────────────────────────────────────────────

/** A property variable declared on the root rule. */
export interface PapiVariable {
  name: string;
  /** Declared default. Empty string is common and meaningful. */
  value: string;
  description?: string;
  hidden?: boolean;
  sensitive?: boolean;
}

/** One node of the PAPI rule tree, exactly as it appears in the JSON. */
export interface PapiRule {
  name: string;
  uuid?: string;
  comments?: string;
  criteria?: AkamaiRuleEntry[];
  behaviors?: AkamaiRuleEntry[];
  children?: PapiRule[];
  /** "all" = AND between criteria, "any" = OR. Absent means "all". */
  criteriaMustSatisfy?: 'all' | 'any';
  /** Declared only on the root rule. */
  variables?: PapiVariable[];
  templateLink?: string;
}

/** Top level of the uploaded file. */
export interface PropertyDoc {
  propertyName: string;
  propertyVersion: number;
  propertyId?: string;
  contractId?: string;
  groupId?: string;
  ruleFormat?: string;
  rules: PapiRule;
}

// ── Flattened index ──────────────────────────────────────────────────

/**
 * One entry per rule, built once at load. The tree is walked constantly
 * (evaluation, search, rendering), so it's flattened into an array with
 * parent/child ids rather than traversed recursively each time.
 */
export interface RuleNode {
  id: number;
  depth: number;
  /** null for the root rule. */
  parent: number | null;
  rule: PapiRule;
  /** Ancestor rule names, root first. Excludes this rule's own name. */
  trail: string[];
  children: number[];
  /** Lowercased name + comments + uuid + all criteria/behavior option values. */
  searchBlob: string;
}

/**
 * A conditional-origin arm the property actually routes on.
 *
 * Only arms whose rule carries an `origin` behavior are included — the
 * INSHUB / REWARDS / Dory arms are conditional-origin declarations for
 * other products and have no effect on where a request goes.
 */
export interface CloudletArm {
  originId: string;
  /** Set when the arm hardcodes a host instead of following PMUSER_TARGET. */
  pinsHost: string | null;
}

/** Everything derived from the config at load time. */
export interface ConfigIndex {
  doc: PropertyDoc;
  nodes: RuleNode[];
  /** Distinct literal hostnames referenced by any hostname criterion. */
  hostnames: string[];
  cloudletArms: CloudletArm[];
  /**
   * Per-scope GTM answers: gtmMap[PMUSER_GTM value][DC] = origin host.
   * Derived by pairing each scope's PMUSER_GTM literal with the concrete
   * origins its BCC / SCC cookie branches assign.
   */
  gtmMap: Record<string, Record<string, string>>;
  /**
   * Variables assigned somewhere by a setVariable behavior. Ones absent
   * from this set come from advanced XML or the edge at runtime, so their
   * declared default is not their real value and must stay unknown.
   */
  assignedVariables: Set<string>;
}

// ── Request ──────────────────────────────────────────────────────────

/** A cookie whose pinned value disagrees with what the estate would issue. */
export interface CookieDrift {
  name: string;
  /** The value the request carries. */
  has: string;
  /** The value the current cloudlet arm + GTM answer would stamp. */
  would: string;
}

export interface TraceRequest {
  hostname: string;
  path: string;
  query: string;
  /** Lowercase, no leading dot. Empty when the path has no extension. */
  fileExtension: string;
  /**
   * Session cookies. A key present with an empty value means "cookie not
   * set"; a key that is absent entirely means "unknown", which leaves
   * criteria on it undecidable.
   */
  cookies: Record<string, string>;
  /** Selected conditional-origin arm, or '' for unknown. */
  cloudletArm: string;
  /** 'www13' (BCC), 'www12' (SCC), or '' for unknown. */
  gtmAnswer: string;
  drift: CookieDrift[];
}

// ── Evaluation result ────────────────────────────────────────────────

export interface MatchedRule {
  id: number;
  status: MatchStatus;
  /** Criteria that couldn't be decided, by name. */
  unknown: string[];
}

/** Where a variable's value came from, for the "Decided" line. */
export interface VarProvenance {
  /** The expression or source that produced it. */
  raw: string;
  value: string;
  /** null when seeded from the property default or a supplied answer. */
  ruleId: number | null;
  ruleName: string;
}

export interface TraceResult {
  /** Matched rules in evaluation order. */
  matched: MatchedRule[];
  vars: Record<string, string>;
  prov: Record<string, VarProvenance>;
}

// ── Outcome ──────────────────────────────────────────────────────────

export interface RuleRef {
  ruleId: number;
  ruleName: string;
}

export interface RewriteStep extends RuleRef {
  before: string;
  after: string;
}

export interface CookieWrite extends RuleRef {
  name: string;
  value: string;
}

export interface OriginResult extends RuleRef {
  /** Expanded hostname. May contain the unresolved marker. */
  host: string;
  /** The behavior's raw hostname option, e.g. "{{user.PMUSER_TARGET}}". */
  raw: string;
  resolved: boolean;
  forwardHostHeader?: string;
}

export interface RedirectResult extends RuleRef {
  code: string;
  to: string;
}

/** One segment of the "Decided" summary line. */
export interface DecidedStep {
  label: string;
  /** Rendered in amber — a forced invalidation or a missing input. */
  warn?: boolean;
}

export interface Outcome {
  startPath: string;
  /** Path after applying every matched rewriteUrl in order. */
  path: string;
  rewrites: RewriteStep[];
  /**
   * The last matching origin, resolved or not. PAPI applies origins in
   * order and the last one wins, so falling back to an earlier literal
   * would name a host the request never reaches.
   */
  origin: OriginResult | null;
  /** Session-routing cookies stamped on the response. */
  cookies: CookieWrite[];
  redirect: RedirectResult | null;
  /** Rule id → plain-language list of what that rule did. */
  actions: Record<number, string[]>;
  decided: DecidedStep[];
}

// ── Search ───────────────────────────────────────────────────────────

/** A field whose value contains the search term. */
export interface MatchField {
  /** e.g. "rewriteUrl.targetUrl", "path.values", "comments". */
  label: string;
  text: string;
}
