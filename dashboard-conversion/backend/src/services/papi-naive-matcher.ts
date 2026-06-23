import type { AkamaiRule, AkamaiRuleEntry } from './akamai.service';

// ── Types ────────────────────────────────────────────────────────────

/**
 * The parsed-URL input the matcher evaluates against.
 *
 * Construct from a URL string in the route handler:
 *   const u = new URL(input);
 *   const parsed = {
 *     hostname: u.hostname,
 *     path: u.pathname,
 *     fileExtension: extractExtension(u.pathname)
 *   };
 *
 * The matcher itself takes only this shape — it doesn't parse URLs.
 */
export interface ParsedRequestUrl {
  hostname: string;
  path: string;
  /** Extracted file extension (no leading dot, lowercase). Empty string if none. */
  fileExtension: string;
  /** Query string without the leading '?'. Empty string if none. */
  query: string;
}

/**
 * Status of a matched rule, used to communicate confidence in the match.
 *
 * - "full":    every criterion in the rule was supported and evaluated, and
 *              the rule's criteriaMustSatisfy condition was satisfied.
 *              Highest confidence.
 * - "partial": the rule's criteriaMustSatisfy was satisfied by the
 *              criteria we could evaluate, BUT one or more criteria
 *              were unsupported (cookies, headers, geo, regex, etc.) so
 *              we can't be 100% certain PAPI would also match this rule
 *              at runtime. Medium confidence.
 *
 * Non-matches are not returned in the result list at all.
 */
export type MatchStatus = 'full' | 'partial';

/**
 * A single rule that the URL matched, with its full ancestor path,
 * the criteria + behaviors that define it, and a list of any criteria
 * that couldn't be evaluated.
 *
 * Carries the full `behaviors` and `criteria` arrays (not just names)
 * so the frontend can render expand-on-click rule details without
 * needing a follow-up call to fetch the rule tree.
 */
export interface MatchedRule {
  /** Rule names from root to this rule, e.g. ["default", "Separate origins for DPs", "Origin for X"]. */
  rulePath: string[];
  /** This rule's name (last element of rulePath, duplicated for convenience). */
  ruleName: string;
  /** "full" or "partial" — see MatchStatus docs. */
  matchStatus: MatchStatus;
  /** Names of criteria on this rule that we couldn't evaluate (unsupported type or operator). */
  unevaluatedCriteria: string[];
  /** Names of behaviors defined on this rule (kept for backward compat / quick chip rendering). */
  behaviorNames: string[];
  /** Full behaviors array — used by the UI's expand-on-click detail view. */
  behaviors: AkamaiRuleEntry[];
  /** Full criteria array — same purpose as behaviors. */
  criteria: AkamaiRuleEntry[];
  /** Logical operator between criteria on this rule: "all" (AND) or "any" (OR). Defaults to "all" when unset. */
  criteriaMustSatisfy: 'all' | 'any';
}

/** Supported criterion types. Adding a new type means extending evaluateCriterion(). */
const SUPPORTED_CRITERIA = new Set(['path', 'hostname', 'fileExtension']);

/** Supported match operators. Adding a new operator means extending evaluateCriterion(). */
const SUPPORTED_OPERATORS = new Set([
  'MATCHES_ONE_OF',
  'DOES_NOT_MATCH_ONE_OF',
  'IS_ONE_OF',
  'IS_NOT_ONE_OF'
]);

/**
 * Optional inputs that let the matcher resolve variable- and
 * cloudlet-gated rules deterministically instead of marking them
 * conditional. All optional — with none supplied, behaviour is the
 * prior static match (variable/cloudlet gates stay conditional).
 */
export interface MatchOptions {
  /** Blue/green colour selector (blue|green|standard) → resolves cloudletsOrigin arms. */
  colour?: string;
  /** Site/env selector (e.g. "qa1") → resolves cloudletsOrigin arms. */
  site?: string;
  /** Whether this URL routes through the cloudlet at all (colour-prefixed or GSS host). */
  isCloudletUrl?: boolean;
  /** Drop the Shape routing subtree (unused in practice). */
  suppressShape?: boolean;
  /** Declared PM variable defaults (rules.variables) used to seed state. */
  variableDefaults?: Record<string, string>;
}

/** Internal simulation state carried through the walk. */
interface SimContext {
  vars: Record<string, string>;
  selectors: { colour?: string; site?: string };
  isCloudletUrl: boolean;
  suppressShape: boolean;
}

/** Result of a match run: the matched rules plus the resolved variable state. */
export interface MatchResult {
  matchedRules: MatchedRule[];
  vars: Record<string, string>;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Walks the rule tree and returns every rule whose criteria match the
 * given URL.
 *
 * Strict tree walk: a rule's children are only evaluated if the rule
 * itself matches (full or partial). This mirrors PAPI's runtime
 * semantics — child rules only apply when their parent's criteria are
 * satisfied.
 *
 * Pure function. No side effects, no I/O, no logging.
 */
export function matchUrl(
  rootRule: AkamaiRule,
  url: ParsedRequestUrl,
  options: MatchOptions = {}
): MatchResult {
  const results: MatchedRule[] = [];
  const ctx: SimContext = {
    vars: seedVariables(url, options.variableDefaults),
    selectors: { colour: options.colour, site: options.site },
    isCloudletUrl: options.isCloudletUrl === true,
    suppressShape: options.suppressShape === true
  };
  walk(rootRule, [], url, results, 'full', ctx);
  return { matchedRules: results, vars: ctx.vars };
}

/**
 * Convenience helper for callers that have a URL string. Returns the
 * parsed shape the matcher expects, or null if the URL is malformed.
 *
 * Exported separately so the route handler can produce a structured
 * 400 error before invoking the matcher.
 */
export function parseRequestUrl(urlString: string): ParsedRequestUrl | null {
  if (!urlString || typeof urlString !== 'string') return null;
  try {
    const u = new URL(urlString);
    return {
      hostname: u.hostname.toLowerCase(),
      path: u.pathname || '/',
      fileExtension: extractFileExtension(u.pathname),
      query: (u.search || '').replace(/^\?/, '')
    };
  } catch {
    return null;
  }
}

/**
 * Classifies a hostname for cloudlet routing. Cloudlet/COG handling only
 * applies when the host carries a colour prefix or a GSS pair token:
 *   blue./green.        → colour known from the prefix
 *   olb-gss-qa<NN>      → GSS pair (e.g. qa56 → [qa5, qa6]); needs a pick
 *   olb-qa<N> (no gss)  → specific site, bypasses cloudlet
 */
export interface HostnameClass {
  colourPrefix?: 'blue' | 'green';
  specificSite?: string;
  gssPair?: string;
  pairSites: string[];
  isCloudletUrl: boolean;
}

export function classifyHostname(hostname: string): HostnameClass {
  const lo = (hostname || '').toLowerCase();
  const colourPrefix = lo.startsWith('blue.') ? 'blue' : lo.startsWith('green.') ? 'green' : undefined;
  const gss = lo.match(/gss-qa(\d+)/);
  if (gss) {
    return { colourPrefix, gssPair: 'qa' + gss[1], pairSites: expandEnvPair(gss[1]), isCloudletUrl: true };
  }
  const specific = lo.match(/olb-qa(\d+)/);
  return {
    colourPrefix,
    specificSite: specific ? 'qa' + specific[1] : undefined,
    pairSites: [],
    isCloudletUrl: !!colourPrefix
  };
}

// ── Internal: tree walk ──────────────────────────────────────────────

function walk(
  rule: AkamaiRule,
  ancestors: string[],
  url: ParsedRequestUrl,
  out: MatchedRule[],
  parentStatus: MatchStatus,
  ctx: SimContext
): void {
  // Shape routing is unused in practice; drop the whole subtree when asked.
  if (ctx.suppressShape && /shape/i.test(rule.name)) {
    return;
  }

  const rulePath = [...ancestors, rule.name];
  const evaluation = evaluateRule(rule, url, ctx);

  if (!evaluation.matched) {
    // Non-matching rule: don't record it, don't walk its children.
    // Strict tree walk semantics — children only evaluated under
    // matching parents.
    return;
  }

  // Effective status is the weakest link in the chain: a child can be no
  // more confident than its ancestors. A "full" leaf under a gated (e.g.
  // variable/header/cookie) parent is really conditional — without this,
  // gated subtrees (Shape, Mobile-IDP, Conditional Origin Groups) would
  // surface as full matches and pollute the mainline origin/rewrite winner.
  const effectiveStatus: MatchStatus =
    parentStatus === 'partial' ? 'partial' : evaluation.status;

  // Only a fully-resolved rule mutates simulation state. A partial match
  // isn't certain to apply, so its setVariable assignments must not taint
  // the state later rules are evaluated against.
  if (effectiveStatus === 'full') {
    applySetVariables(rule, ctx.vars);
  }

  // Record this rule.
  out.push({
    rulePath,
    ruleName: rule.name,
    matchStatus: effectiveStatus,
    unevaluatedCriteria: evaluation.unevaluatedCriteria,
    behaviorNames: (rule.behaviors || []).map(b => b.name),
    behaviors: rule.behaviors || [],
    criteria: rule.criteria || [],
    criteriaMustSatisfy: rule.criteriaMustSatisfy || 'all'
  });

  // Walk children, propagating this rule's effective status downward.
  for (const child of rule.children || []) {
    walk(child, rulePath, url, out, effectiveStatus, ctx);
  }
}

// ── Internal: per-rule evaluation ────────────────────────────────────

interface RuleEvaluation {
  matched: boolean;
  status: MatchStatus;
  unevaluatedCriteria: string[];
}

/**
 * Evaluates a single rule's criteria against the URL. Honors
 * criteriaMustSatisfy ("all" = AND, "any" = OR). Tracks unsupported
 * criteria separately so we can flag partial matches.
 *
 * Empty criteria array = unconditional match (this is how the default
 * rule typically works). Returns matched=true with status="full".
 */
function evaluateRule(rule: AkamaiRule, url: ParsedRequestUrl, ctx: SimContext): RuleEvaluation {
  const criteria = rule.criteria || [];
  const mustSatisfy = rule.criteriaMustSatisfy || 'all';

  if (criteria.length === 0) {
    // No criteria = unconditional match. The default (root) rule is
    // typically like this.
    return { matched: true, status: 'full', unevaluatedCriteria: [] };
  }

  let supportedCount = 0;
  let passedCount = 0;
  const unevaluated: string[] = [];

  for (const criterion of criteria) {
    const result = evaluateCriterion(criterion, url, ctx, rule);
    if (result === 'unsupported') {
      unevaluated.push(criterion.name);
      continue;
    }
    supportedCount++;
    if (result === 'pass') passedCount++;
  }

  if (mustSatisfy === 'all') {
    // AND: every supported criterion must pass. If any failed, no match.
    if (supportedCount > 0 && passedCount < supportedCount) {
      return { matched: false, status: 'full', unevaluatedCriteria: unevaluated };
    }
    // All supported passed (or none were supported). If unevaluated > 0,
    // partial; otherwise full.
    if (unevaluated.length > 0) {
      // No supported criteria evaluated to false, but we have unknowns.
      // If supportedCount is 0 (every criterion was unsupported), it's
      // still a partial match — we know nothing about whether it
      // actually applies, only that nothing we could check ruled it out.
      return { matched: true, status: 'partial', unevaluatedCriteria: unevaluated };
    }
    return { matched: true, status: 'full', unevaluatedCriteria: [] };
  }

  // criteriaMustSatisfy === 'any' (OR)
  if (passedCount > 0) {
    // At least one supported criterion passed. If unevaluated > 0,
    // we still call it full — OR semantics mean one pass is enough.
    return {
      matched: true,
      status: unevaluated.length > 0 ? 'partial' : 'full',
      unevaluatedCriteria: unevaluated
    };
  }
  // No supported criterion passed. If we have unevaluated, partial
  // (one of those might have passed in PAPI). Otherwise no match.
  if (unevaluated.length > 0) {
    return { matched: true, status: 'partial', unevaluatedCriteria: unevaluated };
  }
  return { matched: false, status: 'full', unevaluatedCriteria: [] };
}

// ── Internal: per-criterion evaluation ──────────────────────────────

type CriterionResult = 'pass' | 'fail' | 'unsupported';

/**
 * Evaluates a single criterion against the URL. Returns:
 *   - "pass":        the criterion is satisfied by this URL
 *   - "fail":        the criterion is not satisfied
 *   - "unsupported": we don't know how to evaluate this criterion type
 *                    or operator (e.g. cookies, headers, geo, regex)
 */
function evaluateCriterion(
  criterion: AkamaiRuleEntry,
  url: ParsedRequestUrl,
  ctx: SimContext,
  rule: AkamaiRule
): CriterionResult {
  // Variable- and cloudlet-gated criteria are resolved from simulation
  // state / selectors when possible; otherwise they fall through as
  // 'unsupported' (→ conditional), exactly as before.
  if (criterion.name === 'matchVariable') {
    return evaluateMatchVariable(criterion.options || {}, ctx.vars);
  }
  if (criterion.name === 'cloudletsOrigin') {
    return evaluateCloudletsOrigin(criterion.options || {}, rule, ctx.selectors, ctx.isCloudletUrl);
  }

  if (!SUPPORTED_CRITERIA.has(criterion.name)) {
    return 'unsupported';
  }

  const opts = criterion.options || {};
  const operator = typeof opts.matchOperator === 'string' ? opts.matchOperator : '';
  if (!SUPPORTED_OPERATORS.has(operator)) {
    return 'unsupported';
  }

  const values = Array.isArray(opts.values) ? (opts.values as unknown[]).filter(v => typeof v === 'string') as string[] : [];
  const caseSensitive = opts.matchCaseSensitive === true;

  let target: string;
  if (criterion.name === 'path') {
    target = url.path;
  } else if (criterion.name === 'hostname') {
    target = url.hostname;
  } else if (criterion.name === 'fileExtension') {
    target = url.fileExtension;
  } else {
    // Belt-and-braces; SUPPORTED_CRITERIA guard above should prevent this.
    return 'unsupported';
  }

  // Hostnames and file extensions are inherently case-insensitive in
  // practice; honor matchCaseSensitive only on path.
  const compareCaseInsensitive = !caseSensitive || criterion.name !== 'path';

  // For MATCHES_ONE_OF / DOES_NOT_MATCH_ONE_OF on paths, values use
  // glob-style wildcards (*). For IS_ONE_OF / IS_NOT_ONE_OF, exact match.
  const valueMatches = (value: string): boolean => {
    if (operator === 'MATCHES_ONE_OF' || operator === 'DOES_NOT_MATCH_ONE_OF') {
      return globMatch(target, value, compareCaseInsensitive);
    }
    // IS_ONE_OF / IS_NOT_ONE_OF: exact match
    if (compareCaseInsensitive) {
      return target.toLowerCase() === value.toLowerCase();
    }
    return target === value;
  };

  const anyMatch = values.some(valueMatches);

  switch (operator) {
    case 'MATCHES_ONE_OF':
    case 'IS_ONE_OF':
      return anyMatch ? 'pass' : 'fail';
    case 'DOES_NOT_MATCH_ONE_OF':
    case 'IS_NOT_ONE_OF':
      return anyMatch ? 'fail' : 'pass';
    default:
      return 'unsupported';
  }
}

// ── Internal: helpers ────────────────────────────────────────────────

/**
 * Extracts the file extension from a URL pathname. Returns lowercase,
 * no leading dot. Empty string if no extension.
 *
 * Examples:
 *   "/banking/foo.jpg"      → "jpg"
 *   "/banking/foo"          → ""
 *   "/banking/foo.JPG"      → "jpg"
 *   "/path.with.dots/file"  → ""    (no extension on the last segment)
 *   "/"                     → ""
 */
function extractFileExtension(pathname: string): string {
  if (!pathname) return '';
  // Last path segment.
  const lastSlash = pathname.lastIndexOf('/');
  const lastSegment = lastSlash >= 0 ? pathname.substring(lastSlash + 1) : pathname;
  const lastDot = lastSegment.lastIndexOf('.');
  if (lastDot < 0 || lastDot === lastSegment.length - 1) return '';
  return lastSegment.substring(lastDot + 1).toLowerCase();
}

/**
 * Glob-to-regex match. Supports `*` (any chars) and `?` (single char).
 * Anchored to start and end implicitly — i.e. the pattern must match
 * the entire target, not just a substring. All other regex
 * metacharacters in the pattern are escaped.
 *
 * caseInsensitive=true compares both sides lowercased.
 */
function globMatch(target: string, pattern: string, caseInsensitive: boolean): boolean {
  // Escape regex metacharacters EXCEPT * and ?, which we'll translate.
  // Order matters: we have to escape backslash first, then process *, ?.
  let regexSrc = '';
  for (const ch of pattern) {
    switch (ch) {
      case '*':
        regexSrc += '.*';
        break;
      case '?':
        regexSrc += '.';
        break;
      // Regex metachars we need to escape so user values aren't
      // accidentally interpreted as regex patterns.
      case '.':
      case '+':
      case '^':
      case '$':
      case '(':
      case ')':
      case '[':
      case ']':
      case '{':
      case '}':
      case '|':
      case '\\':
        regexSrc += '\\' + ch;
        break;
      default:
        regexSrc += ch;
    }
  }

  try {
    const flags = caseInsensitive ? 'i' : '';
    const re = new RegExp('^' + regexSrc + '$', flags);
    return re.test(target);
  } catch {
    // Defensive: if regex construction somehow fails, treat as no match.
    return false;
  }
}

// ── Internal: variable-state simulation (Track B) ───────────────────

/**
 * Builds the initial variable state: declared PM-variable defaults
 * (from rules.variables), then the two builtins we can compute from the
 * URL — PMUSER_PATH and PMUSER_QS. Keys are upper-cased so lookups are
 * case-insensitive against criteria/behaviors.
 */
function seedVariables(url: ParsedRequestUrl, defaults?: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};
  if (defaults) {
    for (const [name, value] of Object.entries(defaults)) {
      vars[name.toUpperCase()] = value;
    }
  }
  vars['PMUSER_PATH'] = url.path;
  vars['PMUSER_QS'] = url.query || '';
  return vars;
}

/**
 * Applies a rule's setVariable behaviors to the state. Only literal
 * EXPRESSION values are resolvable; EXTRACT and {{...}}-interpolated
 * sources are runtime-derived and left as their seeded default.
 */
function applySetVariables(rule: AkamaiRule, vars: Record<string, string>): void {
  for (const behavior of rule.behaviors || []) {
    if (behavior.name !== 'setVariable') continue;
    const o = behavior.options || {};
    const name = asStr(o.variableName);
    if (!name) continue;
    if (o.valueSource === 'EXPRESSION') {
      const value = o.variableValue;
      if (typeof value === 'string' && !value.includes('{{')) {
        vars[name.toUpperCase()] = value;
      }
    }
  }
}

/**
 * Evaluates a matchVariable criterion against simulation state. A
 * variable absent from state is genuinely unknown → 'unsupported'
 * (conditional). Known → pass/fail.
 */
function evaluateMatchVariable(
  opts: Record<string, unknown>,
  vars: Record<string, string>
): CriterionResult {
  const name = asStr(opts.variableName).toUpperCase();
  if (!name || !(name in vars)) return 'unsupported';

  const current = vars[name] ?? '';
  // An empty value means the variable is unset/unknown — its declared
  // default is blank and nothing on this path assigned it. Asserting a gate
  // against an unknown produces false matches (e.g. an empty default
  // satisfying an "IS <blank>" gate, turning a dormant subtree like
  // ISAM_Mobile_IDP into an always-on mainline origin). Treat as conditional.
  if (current === '') return 'unsupported';
  const operator = asStr(opts.matchOperator);
  const rawValues = Array.isArray(opts.variableValues)
    ? opts.variableValues
    : Array.isArray((opts as { values?: unknown[] }).values)
      ? (opts as { values: unknown[] }).values
      : [];
  const values = (rawValues as unknown[]).filter(v => typeof v === 'string') as string[];
  const caseInsensitive = opts.matchCaseSensitive !== true;
  const eq = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  const anyEq = values.some(v => eq(current, v));

  switch (operator) {
    case 'IS_ONE_OF': return anyEq ? 'pass' : 'fail';
    case 'IS_NOT_ONE_OF': return anyEq ? 'fail' : 'pass';
    case 'IS': return values.length ? (eq(current, values[0]) ? 'pass' : 'fail') : (current === '' ? 'pass' : 'fail');
    case 'IS_NOT': return values.length ? (eq(current, values[0]) ? 'fail' : 'pass') : (current === '' ? 'fail' : 'pass');
    case 'IS_EMPTY': return current === '' ? 'pass' : 'fail';
    case 'IS_NOT_EMPTY': return current !== '' ? 'pass' : 'fail';
    default: return 'unsupported';
  }
}

/**
 * Resolves a cloudletsOrigin criterion against the colour/site selectors.
 * Core arms (bcc/scc/blue/green + env) resolve to pass/fail; feature
 * groups (INSHUB/REWARDS/DORYSSO/launch) stay conditional. With no
 * selector supplied, the arm stays conditional too.
 */
function evaluateCloudletsOrigin(
  opts: Record<string, unknown>,
  rule: AkamaiRule,
  selectors: { colour?: string; site?: string },
  isCloudletUrl: boolean
): CriterionResult {
  const id = asStr(opts.originId);
  if (!id) return 'unsupported';
  // Plain (non-colour, non-GSS) URLs never enter the cloudlet — prune the
  // whole Conditional Origin Group rather than showing it as conditional.
  if (!isCloudletUrl) return 'fail';
  if (!selectors.colour && !selectors.site) return 'unsupported';

  const cls = classifyCloudletId(id, originHostOf(rule));
  if (!cls.core) return 'unsupported';

  const colourOk = !selectors.colour || cls.colour === selectors.colour.toLowerCase();
  const siteOk = !selectors.site || cls.sites.has(selectors.site.toLowerCase());
  return colourOk && siteOk ? 'pass' : 'fail';
}

/**
 * Infers (colour, site set, core?) from a cloudlet origin id and the
 * arm's own origin hostname. Sites come from a qaN token in the id, an
 * olb-qaN token in the origin host, or an env-pair suffix (56 → qa5/qa6).
 */
function classifyCloudletId(id: string, originHost: string): { colour: string; core: boolean; sites: Set<string> } {
  const lo = id.toLowerCase();
  const colour = lo.includes('blue') ? 'blue' : lo.includes('green') ? 'green' : 'standard';
  const core = /^(bcc|scc|blue|green)/.test(lo);
  const sites = new Set<string>();
  for (const m of lo.matchAll(/qa(\d+)/g)) sites.add('qa' + m[1]);
  if (originHost) {
    for (const m of originHost.toLowerCase().matchAll(/olb-qa(\d+)/g)) sites.add('qa' + m[1]);
  }
  // Standard (bcc/scc) arms are single-site — their site comes from the
  // origin host above. Only blue/green arms serve both envs of a pair.
  if (colour !== 'standard') {
    const pair = lo.match(/(\d{2,4})$/);
    if (pair) for (const s of expandEnvPair(pair[1])) sites.add(s);
  }
  return { colour, core, sites };
}

function expandEnvPair(digits: string): string[] {
  const map: Record<string, string[]> = {
    '34': ['qa3', 'qa4'],
    '56': ['qa5', 'qa6'],
    '78': ['qa7', 'qa8'],
    '910': ['qa9', 'qa10'],
    '1112': ['qa11', 'qa12']
  };
  return map[digits] || [];
}

function originHostOf(rule: AkamaiRule): string {
  for (const behavior of rule.behaviors || []) {
    if (behavior.name === 'origin') return asStr((behavior.options || {}).hostname);
  }
  return '';
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
