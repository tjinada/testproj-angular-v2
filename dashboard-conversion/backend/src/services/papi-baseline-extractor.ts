import type { AkamaiRule, AkamaiRuleEntry } from './akamai.service';

/**
 * Baseline values pulled from the default (root) rule's behaviors.
 *
 * These are the property's "if no child rule overrides anything" defaults.
 * Child rules can (and frequently do) override individual fields — those
 * overrides are surfaced separately by the naive matcher (step 6), not
 * here.
 *
 * Every field is optional because PAPI configs vary: not every property
 * defines an `origin` at the root, not every property has a `cpCode`
 * behavior at the root, etc. Missing fields are reported as `undefined`
 * — we never fabricate defaults.
 */
export interface AkamaiBaseline {
  origin?: {
    /** e.g. "bos-ocbqlweb-vip11.bmogc.net" */
    hostname?: string;
    /** "REQUEST_HOST_HEADER" | "ORIGIN_HOSTNAME" | "CUSTOM" */
    forwardHostHeader?: string;
    /** "ORIGIN_HOSTNAME" | "REQUEST_HOST_HEADER" | "CUSTOM" */
    cacheKeyHostname?: string;
    /** "CUSTOMER" | "NET_STORAGE" | "MEDIA_SERVICE_LIVE" | "EDGE_LOAD_BALANCING_ORIGIN_GROUP" | "SAAS_DYNAMIC_ORIGIN" */
    originType?: string;
    httpPort?: number;
    httpsPort?: number;
  };
  caching?: {
    /** "MAX_AGE" | "NO_STORE" | "BYPASS_CACHE" | "CACHE_CONTROL_AND_EXPIRES" | "CACHE_CONTROL" | "EXPIRES" | "NO_CACHE" */
    behavior?: string;
    /** Defined when behavior is MAX_AGE; e.g. "1d", "30m", "2h". */
    ttl?: string;
    /** Whether stale-while-revalidate / honor-private-cache headers are on. */
    mustRevalidate?: boolean;
  };
  cpCode?: {
    id?: number;
    name?: string;
  };
}

/**
 * Represents one behavior that was looked at but not pulled into a
 * structured slot (because we don't have a typed shape for it).
 * Lets the UI show "the root rule also defines: X, Y, Z" without us
 * having to model every PAPI behavior up front.
 */
export interface AkamaiBaselineDiagnostics {
  /** Total count of behaviors on the default rule. */
  defaultRuleBehaviorCount: number;
  /** Names of behaviors we recognised and extracted. */
  extractedBehaviorNames: string[];
  /** Names of behaviors present but not extracted into structured fields. */
  unextractedBehaviorNames: string[];
}

export interface ExtractBaselineResult {
  baseline: AkamaiBaseline;
  diagnostics: AkamaiBaselineDiagnostics;
}

/**
 * Pulls baseline behavior info from the default (root) rule.
 *
 * STRICT interpretation: only the root rule's own `behaviors` array is
 * inspected. Unconditional child rules (children with empty criteria
 * arrays) are NOT walked — that's a step toward a real evaluator and
 * lives in phase 2 if/when needed.
 *
 * Pure function. No side effects, no PAPI calls, no logging.
 */
export function extractBaseline(rootRule: AkamaiRule): ExtractBaselineResult {
  const behaviors = rootRule.behaviors || [];
  const baseline: AkamaiBaseline = {};
  const extracted: string[] = [];
  const unextracted: string[] = [];

  for (const behavior of behaviors) {
    const handled = applyBehavior(behavior, baseline);
    if (handled) {
      extracted.push(behavior.name);
    } else {
      unextracted.push(behavior.name);
    }
  }

  return {
    baseline,
    diagnostics: {
      defaultRuleBehaviorCount: behaviors.length,
      extractedBehaviorNames: extracted,
      unextractedBehaviorNames: unextracted
    }
  };
}

/**
 * Routes a single behavior to its structured slot in the baseline.
 * Returns true if we recognized and extracted the behavior, false if
 * we passed it over (so the caller can record it as unextracted).
 *
 * Adding support for a new behavior = one new case here. Keeping the
 * dispatch in one place makes the supported set easy to audit.
 */
function applyBehavior(behavior: AkamaiRuleEntry, baseline: AkamaiBaseline): boolean {
  const opts = behavior.options || {};

  switch (behavior.name) {
    case 'origin': {
      baseline.origin = {
        hostname: stringOrUndefined(opts.hostname),
        forwardHostHeader: stringOrUndefined(opts.forwardHostHeader),
        cacheKeyHostname: stringOrUndefined(opts.cacheKeyHostname),
        originType: stringOrUndefined(opts.originType),
        httpPort: numberOrUndefined(opts.httpPort),
        httpsPort: numberOrUndefined(opts.httpsPort)
      };
      return true;
    }

    case 'caching': {
      baseline.caching = {
        behavior: stringOrUndefined(opts.behavior),
        ttl: stringOrUndefined(opts.ttl),
        mustRevalidate: boolOrUndefined(opts.mustRevalidate)
      };
      return true;
    }

    case 'cpCode': {
      // PAPI shape: options.value = { id: number, name?: string, ... }
      const value = opts.value as Record<string, unknown> | undefined;
      if (value && typeof value === 'object') {
        baseline.cpCode = {
          id: numberOrUndefined(value.id),
          name: stringOrUndefined(value.name)
        };
      } else {
        baseline.cpCode = {};
      }
      return true;
    }

    default:
      return false;
  }
}

// ── Type-guards: PAPI options come as `unknown` so we narrow safely ──

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolOrUndefined(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
