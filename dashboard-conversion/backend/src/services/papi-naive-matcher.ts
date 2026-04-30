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
export function matchUrl(rootRule: AkamaiRule, url: ParsedRequestUrl): MatchedRule[] {
  const results: MatchedRule[] = [];
  walk(rootRule, [], url, results);
  return results;
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
      fileExtension: extractFileExtension(u.pathname)
    };
  } catch {
    return null;
  }
}

// ── Internal: tree walk ──────────────────────────────────────────────

function walk(
  rule: AkamaiRule,
  ancestors: string[],
  url: ParsedRequestUrl,
  out: MatchedRule[]
): void {
  const rulePath = [...ancestors, rule.name];
  const evaluation = evaluateRule(rule, url);

  if (!evaluation.matched) {
    // Non-matching rule: don't record it, don't walk its children.
    // Strict tree walk semantics — children only evaluated under
    // matching parents.
    return;
  }

  // Record this rule.
  out.push({
    rulePath,
    ruleName: rule.name,
    matchStatus: evaluation.status,
    unevaluatedCriteria: evaluation.unevaluatedCriteria,
    behaviorNames: (rule.behaviors || []).map(b => b.name),
    behaviors: rule.behaviors || [],
    criteria: rule.criteria || [],
    criteriaMustSatisfy: rule.criteriaMustSatisfy || 'all'
  });

  // Walk children.
  for (const child of rule.children || []) {
    walk(child, rulePath, url, out);
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
function evaluateRule(rule: AkamaiRule, url: ParsedRequestUrl): RuleEvaluation {
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
    const result = evaluateCriterion(criterion, url);
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
function evaluateCriterion(criterion: AkamaiRuleEntry, url: ParsedRequestUrl): CriterionResult {
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
