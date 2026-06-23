import { Router, Request, Response } from 'express';
import {
  listMonitoredProperties,
  getHostnameMap,
  resolveHostname,
  getRuleTree,
  evaluateUrl,
  EvaluateUrlError
} from '../services/akamai.service';
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
  const withMatchUrl = typeof req.query.withMatch === 'string' ? req.query.withMatch : undefined;
  console.log(`[Akamai/route] GET /api/akamai/_debug/rule-tree (withMatch=${withMatchUrl ? '"' + withMatchUrl + '"' : 'no'})`);

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
 * GET /api/akamai/_debug/match?url=<full-url>
 *
 * Diagnostic GET version of POST /api/akamai/flow. Same orchestration,
 * same response shape — only the input mechanism differs (query string
 * here, JSON body there). Both call evaluateUrl() so they cannot drift.
 *
 * Use this endpoint for quick curl testing during development. The
 * frontend will use POST /flow.
 */
router.get('/_debug/match', async (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : undefined;
  const colour = typeof req.query.colour === 'string' ? req.query.colour : undefined;
  const site = typeof req.query.site === 'string' ? req.query.site : undefined;
  const suppressShape = req.query.suppressShape !== 'false';
  console.log(`[Akamai/route] GET /api/akamai/_debug/match (url=${url ? '"' + url + '"' : 'missing'})`);

  if (!url) {
    return res.status(400).json({ error: 'url query parameter is required (full URL with scheme + host)' });
  }

  try {
    const result = await evaluateUrl(url, { colour, site, suppressShape });
    res.json(result);
  } catch (error: any) {
    if (error instanceof EvaluateUrlError) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.details || {})
      });
    }
    console.error(`[Akamai/route] _debug/match failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to evaluate URL' });
  }
});

/**
 * POST /api/akamai/flow
 * Body: { url: string }
 *
 * The real endpoint the frontend calls. Pastes-URL-and-shows-result
 * pipeline:
 *   1. parse the URL
 *   2. resolve hostname against the monitored property allowlist
 *   3. fetch the property's active production rule tree (cached)
 *   4. extract default-rule baseline (origin, caching, cpCode)
 *   5. run the naive matcher to find rules whose criteria match the URL
 *   6. return everything in one structured payload
 *
 * Errors:
 *   400 — url missing or malformed
 *   404 — hostname not configured on any monitored property (response
 *         includes a sample of configured hostnames)
 *   500 — PAPI failure or unexpected error
 *
 * Identical orchestration to GET /_debug/match — both call evaluateUrl().
 */
router.post('/flow', async (req: Request, res: Response) => {
  const body = req.body || {};
  const url = typeof body.url === 'string' ? body.url : undefined;
  const colour = typeof body.colour === 'string' ? body.colour : undefined;
  const site = typeof body.site === 'string' ? body.site : undefined;
  const suppressShape = body.suppressShape !== false; // Shape unused → suppressed by default
  console.log(`[Akamai/route] POST /api/akamai/flow (url=${url ? '"' + url + '"' : 'missing'}, colour=${colour || '-'}, site=${site || '-'})`);

  if (!url) {
    return res.status(400).json({ error: 'Request body must include url (full URL with scheme + host)' });
  }

  try {
    const result = await evaluateUrl(url, { colour, site, suppressShape });
    res.json(result);
  } catch (error: any) {
    if (error instanceof EvaluateUrlError) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.details || {})
      });
    }
    console.error(`[Akamai/route] /flow failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to evaluate URL' });
  }
});

export default router;
