import type { MatchedRule } from './papi-naive-matcher';

// ── Types ────────────────────────────────────────────────────────────

/**
 * The "where did the URL go?" answer. Computed by walking matched rules
 * in evaluation order (which == the order the matcher returned them, which
 * == depth-first walk order through the rule tree). Later rules' relevant
 * behaviors override earlier ones. The last rule to set each field wins.
 *
 * This is the naive equivalent of what Akamai's edge does at runtime.
 * "Naive" because (a) we only know about rules whose criteria the matcher
 * could evaluate, and (b) partial matches are included in the walk —
 * meaning a rule with an unevaluated cookie criterion might "win" here
 * but not actually fire at runtime if the cookie isn't set.
 */
export interface AkamaiResolution {
  finalOrigin?: {
    hostname?: string;
    forwardHostHeader?: string;
    cacheKeyHostname?: string;
    originType?: string;
    httpPort?: number;
    httpsPort?: number;
    /** Which rule (by full rulePath) contributed this origin. */
    contributedBy: string[];
    /** True if the contributing rule was a partial match. */
    fromPartialMatch: boolean;
  };
  finalCaching?: {
    behavior?: string;
    ttl?: string;
    mustRevalidate?: boolean;
    contributedBy: string[];
    fromPartialMatch: boolean;
  };
  finalCpCode?: {
    id?: number;
    name?: string;
    contributedBy: string[];
    fromPartialMatch: boolean;
  };
  /**
   * True if any of the three "winners" came from a partial-match rule.
   * Drives the disclaimer in the resolution banner UI.
   */
  hasPartialMatchInfluence: boolean;
}

/**
 * Categorization tag attached to each MatchedRule by categorizeRules()
 * (below). Used by the frontend to group rules into decisive /
 * path-specific / always-on sections.
 *
 * - "decisive":      the rule defines origin, cpCode, or caching. These
 *                    actually determine where the URL goes and how it's
 *                    cached. The user's primary interest.
 * - "path-specific": the rule has at least one path or fileExtension
 *                    criterion. Proves the matcher walked into a
 *                    URL-specific subtree. Helpful context.
 * - "always-on":     unconditional rules + rules with only hostname-level
 *                    criteria. They apply everywhere on the site (Security,
 *                    CORS, Headers, etc.). Real, but noise for "where does
 *                    my URL go" questions.
 *
 * "decisive" wins over the others — a rule that has both an origin
 * behavior and only-hostname criteria is still decisive.
 */
export type RuleCategory = 'decisive' | 'path-specific' | 'always-on';

export interface CategorizedMatchedRule extends MatchedRule {
  category: RuleCategory;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Walks matched rules in evaluation order, tracking which rule last
 * contributed each "winning" value (origin, caching, cpCode). Returns
 * the structured resolution.
 *
 * Pure function. No side effects.
 */
export function resolveOutcome(matchedRules: MatchedRule[]): AkamaiResolution {
  const result: AkamaiResolution = { hasPartialMatchInfluence: false };

  for (const rule of matchedRules) {
    const isPartial = rule.matchStatus === 'partial';

    for (const behavior of rule.behaviors) {
      const opts = behavior.options || {};

      switch (behavior.name) {
        case 'origin': {
          result.finalOrigin = {
            hostname: stringOrUndefined(opts['hostname']),
            forwardHostHeader: stringOrUndefined(opts['forwardHostHeader']),
            cacheKeyHostname: stringOrUndefined(opts['cacheKeyHostname']),
            originType: stringOrUndefined(opts['originType']),
            httpPort: numberOrUndefined(opts['httpPort']),
            httpsPort: numberOrUndefined(opts['httpsPort']),
            contributedBy: rule.rulePath,
            fromPartialMatch: isPartial
          };
          if (isPartial) result.hasPartialMatchInfluence = true;
          break;
        }
        case 'caching': {
          result.finalCaching = {
            behavior: stringOrUndefined(opts['behavior']),
            ttl: stringOrUndefined(opts['ttl']),
            mustRevalidate: boolOrUndefined(opts['mustRevalidate']),
            contributedBy: rule.rulePath,
            fromPartialMatch: isPartial
          };
          if (isPartial) result.hasPartialMatchInfluence = true;
          break;
        }
        case 'cpCode': {
          // PAPI cpCode behavior wraps its data inside options.value
          const value = opts['value'] as Record<string, unknown> | undefined;
          if (value && typeof value === 'object') {
            result.finalCpCode = {
              id: numberOrUndefined(value['id']),
              name: stringOrUndefined(value['name']),
              contributedBy: rule.rulePath,
              fromPartialMatch: isPartial
            };
            if (isPartial) result.hasPartialMatchInfluence = true;
          }
          break;
        }
        default:
          // Other behaviors don't contribute to the resolution banner.
          // (They're still visible per-rule in the matched-rule cards.)
          break;
      }
    }
  }

  return result;
}

/**
 * Tags each matched rule with its category. The category is derived
 * from the rule's behaviors and criteria — not from its position in
 * the tree.
 *
 * Pure function.
 */
export function categorizeRules(matchedRules: MatchedRule[]): CategorizedMatchedRule[] {
  return matchedRules.map(rule => ({
    ...rule,
    category: classifyRule(rule)
  }));
}

// ── Internal ────────────────────────────────────────────────────────

const DECISIVE_BEHAVIORS = new Set(['origin', 'caching', 'cpCode']);

const URL_SPECIFIC_CRITERIA = new Set(['path', 'fileExtension']);

function classifyRule(rule: MatchedRule): RuleCategory {
  // Decisive trumps the others — a rule with origin behavior is decisive
  // even if its only criterion is hostname.
  for (const behavior of rule.behaviors) {
    if (DECISIVE_BEHAVIORS.has(behavior.name)) {
      return 'decisive';
    }
  }

  // Path-specific: at least one criterion narrows by URL path/extension.
  for (const criterion of rule.criteria) {
    if (URL_SPECIFIC_CRITERIA.has(criterion.name)) {
      return 'path-specific';
    }
  }

  // Default: always-on. Includes unconditional rules (no criteria) and
  // rules whose criteria are only hostname-level or unsupported types
  // (cookies, headers, geo, etc. — those that apply equally regardless
  // of which path the user's request targets).
  return 'always-on';
}

// ── Type-narrowing helpers (mirrors papi-baseline-extractor) ───────

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolOrUndefined(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
