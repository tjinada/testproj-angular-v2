import { Router, Request, Response } from 'express';
import {
  listMonitoredProperties,
  getHostnameMap,
  resolveHostname,
  getRuleTree
} from '../services/akamai.service';
import { extractBaseline } from '../services/papi-baseline-extractor';
import { matchUrl, parseRequestUrl } from '../services/papi-naive-matcher';

const router = Router();

/**
 * Resolves the (propertyId, version) pair from request query params.
 *
 * Supports two query shapes:
 *   - ?hostname=<host>           → looks up the monitored property
 *   - ?propertyId=prp_XXX&version=N → direct lookup (must still be in allowlist)
 *
 * Returns either { ok: true, propertyId, version, hostname? } or
 * { ok: false, status, error } so callers can short-circuit with
 * res.status(...).json(...).
 *
 * Shared by /_debug/rule-tree, /_debug/baseline, and /_debug/match
 * so all three behave identically for input handling.
 */
async function resolvePropertyTarget(
  req: Request
): Promise<
  | { ok: true; propertyId: string; version: number; hostname?: string; resolvedFromHostname: boolean }
  | { ok: false; status: number; error: string }
> {
  const hostname = typeof req.query.hostname === 'string' ? req.query.hostname : undefined;
  const propertyId = typeof req.query.propertyId === 'string' ? req.query.propertyId : undefined;
  const versionRaw = typeof req.query.version === 'string' ? req.query.version : undefined;

  if (hostname) {
    const match = await resolveHostname(hostname);
    if (!match) {
      return {
        ok: false,
        status: 404,
        error: `Hostname "${hostname}" is not configured on any monitored property`
      };
    }
    return {
      ok: true,
      propertyId: match.propertyId,
      version: match.version,
      hostname,
      resolvedFromHostname: true
    };
  }

  if (propertyId && versionRaw) {
    const parsedVersion = parseInt(versionRaw, 10);
    if (isNaN(parsedVersion) || parsedVersion <= 0) {
      return { ok: false, status: 400, error: 'version must be a positive integer' };
    }
    return {
      ok: true,
      propertyId,
      version: parsedVersion,
      resolvedFromHostname: false
    };
  }

  return {
    ok: false,
    status: 400,
    error: 'Provide either ?hostname=<host> OR ?propertyId=prp_XXX&version=N'
  };
}

/**
 * GET /api/akamai/_debug/properties
 *
 * Returns the resolved monitored-property list (the subset of
 * AKAMAI_PROPERTY_IDS that have a production version).
 *
 * Cached for 30 minutes. Stays in place across later steps as a quick
 * health check; the underscore-prefixed path makes its diagnostic intent
 * explicit and distinct from real /api/akamai/* endpoints added later.
 */
router.get('/_debug/properties', async (_req: Request, res: Response) => {
  console.log(`[Akamai/route] GET /api/akamai/_debug/properties`);

  try {
    const properties = await listMonitoredProperties();
    res.json({
      count: properties.length,
      properties
    });
  } catch (error: any) {
    console.error(`[Akamai/route] _debug/properties failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to list monitored properties' });
  }
});

/**
 * GET /api/akamai/_debug/hostnames
 * GET /api/akamai/_debug/hostnames?lookup=blue.www.olb-qa11.dev.bmo.com
 *
 * Without query: returns the full hostname → property map (case-
 * insensitive lookup table) for verification.
 *
 * With ?lookup=<hostname>: tests the case-insensitive resolution and
 * returns the matched property, or null with the configured-hostname
 * count for context.
 *
 * Cached map is shared with the /flow endpoint (added in step 7), so a
 * miss here means a miss there too.
 */
router.get('/_debug/hostnames', async (req: Request, res: Response) => {
  const lookup = typeof req.query.lookup === 'string' ? req.query.lookup : undefined;
  console.log(`[Akamai/route] GET /api/akamai/_debug/hostnames${lookup ? ` (lookup="${lookup}")` : ''}`);

  try {
    if (lookup) {
      const match = await resolveHostname(lookup);
      const map = await getHostnameMap();
      res.json({
        lookup,
        match,
        configuredHostnameCount: map.size
      });
      return;
    }

    const map = await getHostnameMap();
    // Convert the Map to a sorted array for stable display.
    const entries = Array.from(map.values()).sort((a, b) =>
      a.hostname.localeCompare(b.hostname)
    );
    res.json({
      count: entries.length,
      hostnames: entries
    });
  } catch (error: any) {
    console.error(`[Akamai/route] _debug/hostnames failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to build hostname map' });
  }
});

/**
 * GET /api/akamai/_debug/rule-tree?hostname=<hostname>
 * GET /api/akamai/_debug/rule-tree?propertyId=prp_XXX&version=N
 * GET /api/akamai/_debug/rule-tree?...&withBaseline=true
 * GET /api/akamai/_debug/rule-tree?...&withMatch=<url>
 *
 * Returns the full rule tree for a property version. Two ways to
 * specify which property:
 *   1. ?hostname=...  → resolves hostname → propertyId+version internally
 *      (most ergonomic; this is how the /flow endpoint will work)
 *   2. ?propertyId=...&version=...  → direct lookup, useful if hostname
 *      is not configured but you want to inspect a property anyway
 *
 * Optional flags:
 *   &withBaseline=true   → also include extracted baseline
 *   &withMatch=<url>     → also run the naive matcher against this URL,
 *                          include matched rules + parsed URL in response
 *
 * For just the match results without the giant rule tree payload,
 * use /_debug/match.
 *
 * Cached per (propertyId, version) for 10 minutes.
 */
router.get('/_debug/rule-tree', async (req: Request, res: Response) => {
  const withBaseline = req.query.withBaseline === 'true';
  const withMatchUrl = typeof req.query.withMatch === 'string' ? req.query.withMatch : undefined;
  console.log(`[Akamai/route] GET /api/akamai/_debug/rule-tree (withBaseline=${withBaseline}, withMatch=${withMatchUrl ? '"' + withMatchUrl + '"' : 'no'})`);

  try {
    const target = await resolvePropertyTarget(req);
    if (!target.ok) {
      return res.status(target.status).json({ error: target.error, hostname: req.query.hostname });
    }

    const ruleTree = await getRuleTree(target.propertyId, target.version);

    const payload: Record<string, unknown> = {
      resolvedFromHostname: target.resolvedFromHostname,
      hostname: target.hostname,
      ruleTree
    };

    if (withBaseline) {
      const { baseline, diagnostics } = extractBaseline(ruleTree.rules);
      payload.baseline = baseline;
      payload.baselineDiagnostics = diagnostics;
    }

    if (withMatchUrl) {
      const parsed = parseRequestUrl(withMatchUrl);
      if (!parsed) {
        // Don't fail the whole request — surface as a soft error.
        payload.matchError = `Could not parse withMatch URL: "${withMatchUrl}"`;
      } else {
        const matchedRules = matchUrl(ruleTree.rules, parsed);
        payload.parsedUrl = parsed;
        payload.matchedRules = matchedRules;
        payload.matchedRuleCount = matchedRules.length;
      }
    }

    res.json(payload);
  } catch (error: any) {
    console.error(`[Akamai/route] _debug/rule-tree failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to fetch rule tree' });
  }
});

/**
 * GET /api/akamai/_debug/baseline?hostname=<hostname>
 * GET /api/akamai/_debug/baseline?propertyId=prp_XXX&version=N
 *
 * Returns just the extracted baseline (origin, caching, cpCode) plus
 * extractor diagnostics. Does NOT include the full rule tree — much
 * smaller payload, suitable for quick verification of the extractor
 * without needing to grep through 26,000 lines of JSON.
 *
 * Diagnostics show which behaviors on the default rule were extracted
 * vs. ignored. If you see an "unextractedBehaviorNames" entry that
 * looks important, that's a signal to extend papi-baseline-extractor.ts
 * with a new case.
 */
router.get('/_debug/baseline', async (req: Request, res: Response) => {
  console.log(`[Akamai/route] GET /api/akamai/_debug/baseline`);

  try {
    const target = await resolvePropertyTarget(req);
    if (!target.ok) {
      return res.status(target.status).json({ error: target.error, hostname: req.query.hostname });
    }

    const ruleTree = await getRuleTree(target.propertyId, target.version);
    const { baseline, diagnostics } = extractBaseline(ruleTree.rules);

    res.json({
      resolvedFromHostname: target.resolvedFromHostname,
      hostname: target.hostname,
      property: {
        propertyId: ruleTree.propertyId,
        propertyName: ruleTree.propertyName,
        version: ruleTree.version
      },
      baseline,
      diagnostics
    });
  } catch (error: any) {
    console.error(`[Akamai/route] _debug/baseline failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to extract baseline' });
  }
});

/**
 * GET /api/akamai/_debug/match?url=<full-url>
 *
 * The closest preview to what /api/akamai/flow will look like in step 7.
 * Takes a full URL, parses it, resolves the hostname against the
 * monitored property allowlist, fetches the rule tree, runs the naive
 * matcher, and returns matched rules + baseline + parsed URL.
 *
 * Does NOT include the full rule tree in the response — that's what
 * /_debug/rule-tree is for. This endpoint focuses on what the matcher
 * decided.
 *
 * Use this to validate the matcher's output for real URLs against your
 * configs before any frontend work begins.
 */
router.get('/_debug/match', async (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : undefined;
  console.log(`[Akamai/route] GET /api/akamai/_debug/match (url=${url ? '"' + url + '"' : 'missing'})`);

  if (!url) {
    return res.status(400).json({ error: 'url query parameter is required (full URL with scheme + host)' });
  }

  try {
    const parsed = parseRequestUrl(url);
    if (!parsed) {
      return res.status(400).json({
        error: `Could not parse URL "${url}". Provide a full URL including scheme (https://) and host.`,
        url
      });
    }

    const match = await resolveHostname(parsed.hostname);
    if (!match) {
      const hostnameMap = await getHostnameMap();
      const sample = Array.from(hostnameMap.values())
        .slice(0, 10)
        .map(m => m.hostname);
      return res.status(404).json({
        error: `Hostname "${parsed.hostname}" is not configured on any monitored property`,
        url,
        parsedUrl: parsed,
        configuredHostnameCount: hostnameMap.size,
        configuredHostnamesSample: sample
      });
    }

    const ruleTree = await getRuleTree(match.propertyId, match.version);
    const { baseline, diagnostics: baselineDiagnostics } = extractBaseline(ruleTree.rules);
    const matchedRules = matchUrl(ruleTree.rules, parsed);

    res.json({
      url,
      parsedUrl: parsed,
      property: {
        propertyId: ruleTree.propertyId,
        propertyName: ruleTree.propertyName,
        version: ruleTree.version
      },
      baseline,
      baselineDiagnostics,
      matchedRules,
      matchedRuleCount: matchedRules.length
    });
  } catch (error: any) {
    console.error(`[Akamai/route] _debug/match failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to evaluate URL' });
  }
});

export default router;
