import EdgeGrid = require('akamai-edgegrid');
import { matchUrl, parseRequestUrl, classifyHostname, type ParsedRequestUrl, type HostnameClass, type MatchedRule } from './papi-naive-matcher';
import { resolveFlow, type FlowHop } from './papi-rewrite-resolver';

// ── Types ────────────────────────────────────────────────────────────

/**
 * A property in the AKAMAI_PROPERTY_IDS allowlist that has an active
 * production version. Properties with productionVersion=null are filtered
 * out before this type is returned.
 */
export interface MonitoredProperty {
  propertyId: string;
  propertyName: string;
  contractId: string;
  groupId: string;
  /** Active production version number — never null at this point. */
  version: number;
  /** Latest version (may be > production if newer drafts exist). */
  latestVersion: number;
}

/**
 * Resolved hostname → property mapping. Returned by resolveHostname() and
 * stored in the hostname map.
 */
export interface HostnameMatch {
  hostname: string;
  propertyId: string;
  propertyName: string;
  contractId: string;
  groupId: string;
  version: number;
}

/**
 * A single behavior or criterion entry inside a rule. Both share the
 * same shape: a name (e.g. "origin", "path", "requestCookie") and an
 * `options` object whose contents vary per name. Options are kept as a
 * generic record because the matcher and extractor pull out specific
 * keys per known type rather than trying to type every variant.
 */
export interface AkamaiRuleEntry {
  name: string;
  options: Record<string, unknown>;
}

/**
 * A declared Property Manager variable. Present on the root rule's
 * `variables` array (PAPI returns them inside the rules document — there
 * is no separate variables endpoint). `value` is the default before any
 * setVariable fires; used to seed the matcher's simulation state.
 */
export interface AkamaiPmVariable {
  name: string;
  value?: string;
  description?: string;
  hidden?: boolean;
  sensitive?: boolean;
}

/**
 * A rule node in the PAPI rule tree. The root rule is named "default"
 * and contains the baseline behaviors that apply unless overridden by
 * a child rule.
 *
 * Shape mirrors what PAPI returns at
 *   GET /papi/v1/properties/{id}/versions/{v}/rules
 * No PAPI-internal fields (uuid, locked) are included — keep only what
 * the matcher and extractor actually use.
 */
export interface AkamaiRule {
  name: string;
  children?: AkamaiRule[];
  behaviors?: AkamaiRuleEntry[];
  criteria?: AkamaiRuleEntry[];
  /** "all" (AND between criteria) or "any" (OR). Default: "all". */
  criteriaMustSatisfy?: 'all' | 'any';
  comments?: string;
  /** Declared PM variables — present on the root rule only. Seeds simulation state. */
  variables?: AkamaiPmVariable[];
  /** PAPI internal — kept for completeness, ignored by matcher. */
  templateLink?: string;
  /** PAPI internal — kept for completeness, ignored by matcher. */
  advancedOverride?: string;
}

/**
 * The full rule tree for a property version, plus identifying metadata.
 * Returned by getRuleTree().
 */
export interface PropertyRuleTree {
  propertyId: string;
  propertyName: string;
  version: number;
  /** PAPI etag — useful for change-detection if we ever cache to disk. */
  etag?: string;
  /** Rule format version (e.g. "v2024-02-12"). */
  ruleFormat?: string;
  /** The root rule (name === "default"). */
  rules: AkamaiRule;
}

/** Shape of a single property record in PAPI's /papi/v1/properties response. */
interface PapiPropertyRecord {
  accountId: string;
  contractId: string;
  groupId: string;
  propertyId: string;
  propertyName: string;
  latestVersion: number;
  stagingVersion: number | null;
  productionVersion: number | null;
  assetId?: string;
  note?: string;
}

/** Shape of a hostname item in PAPI's /papi/v1/properties/{id}/versions/{v}/hostnames response. */
interface PapiHostnameItem {
  cnameType: string;
  edgeHostnameId?: string;
  cnameFrom: string;
  cnameTo?: string;
  certProvisioningType?: string;
}

/** Shape of PAPI's /papi/v1/properties/{id}/versions/{v}/rules response. */
interface PapiRuleTreeResponse {
  propertyId: string;
  propertyName: string;
  propertyVersion: number;
  etag?: string;
  ruleFormat?: string;
  rules: AkamaiRule;
}

// ── Constants ────────────────────────────────────────────────────────

/** Cache TTL for monitored properties and the hostname map. */
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Cache TTL for rule trees. Shorter than properties/hostnames because
 * rule trees can be redeployed mid-day (a PM activation) and we want
 * those changes to surface within 10 min without a server restart.
 */
const RULE_TREE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── EdgeGrid client (lazy, env-var driven) ──────────────────────────

let cachedClient: EdgeGrid | null = null;

/**
 * Returns a lazily-initialised EdgeGrid client built from the four
 * AKAMAI_* env vars. Throws with a clear message if any are missing.
 *
 * No .edgerc file is read — credentials come from env vars only, which
 * matches how the rest of this backend (Dynatrace, OpenSearch, etc.)
 * configures secrets. In container deployments these are injected from
 * the secrets manager.
 */
function getClient(): EdgeGrid {
  if (cachedClient) return cachedClient;

  const clientToken = process.env.AKAMAI_CLIENT_TOKEN;
  const clientSecret = process.env.AKAMAI_CLIENT_SECRET;
  const accessToken = process.env.AKAMAI_ACCESS_TOKEN;
  const host = process.env.AKAMAI_HOST;

  console.log(`[Akamai] env check: AKAMAI_HOST=${host ? 'set (' + host.length + ' chars)' : 'MISSING'}`);
  console.log(`[Akamai] env check: AKAMAI_CLIENT_TOKEN=${clientToken ? 'set' : 'MISSING'}`);
  console.log(`[Akamai] env check: AKAMAI_CLIENT_SECRET=${clientSecret ? 'set' : 'MISSING'}`);
  console.log(`[Akamai] env check: AKAMAI_ACCESS_TOKEN=${accessToken ? 'set' : 'MISSING'}`);

  if (!host) throw new Error('AKAMAI_HOST is not set in .env');
  if (!clientToken) throw new Error('AKAMAI_CLIENT_TOKEN is not set in .env');
  if (!clientSecret) throw new Error('AKAMAI_CLIENT_SECRET is not set in .env');
  if (!accessToken) throw new Error('AKAMAI_ACCESS_TOKEN is not set in .env');

  // baseUri must include scheme. The host alone (e.g. akab-xxx.luna.akamaiapis.net)
  // is not a valid baseUri for the library.
  const baseUri = host.startsWith('http') ? host : `https://${host}`;

  cachedClient = new EdgeGrid(clientToken, clientSecret, accessToken, baseUri);
  return cachedClient;
}

// ── Low-level signed request helper ─────────────────────────────────

/**
 * Promise-wrapped signed PAPI request. Returns parsed JSON body on 2xx,
 * throws on network errors or non-2xx with a message that includes the
 * status code and a snippet of the response body for debugging.
 */
function edgeRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  qs?: Record<string, string>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const eg = getClient();
    const startedAt = Date.now();
    const qsLogged = qs ? `?${Object.entries(qs).map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    console.log(`[Akamai] ${method} ${path}${qsLogged}`);

    eg.auth({
      path,
      method,
      headers: { Accept: 'application/json' },
      qs: qs || {},
      body: ''
    });

    eg.send((err: any, response: any, body: any) => {
      const elapsedMs = Date.now() - startedAt;
      if (err) {
        const code = err.code || 'unknown';
        console.error(`[Akamai] ${method} ${path} failed after ${elapsedMs}ms: ${err.message} (code=${code})`);
        return reject(new Error(`Akamai request failed: ${err.message}`));
      }

      // The akamai-edgegrid library's callback shape varies across versions:
      // sometimes response.statusCode (Node http style), sometimes response.status
      // (axios-like), sometimes response is undefined and only body is given.
      // Try all known sources before giving up; treat "unknown but body parses"
      // as 200, since a real network/auth failure goes through the err arg.
      const rawStatus =
        response?.statusCode ??
        response?.status ??
        (response && typeof response === 'object' && 'statusCode' in response ? (response as any).statusCode : undefined);
      const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');
      const preview = bodyText && bodyText.length > 300
        ? bodyText.substring(0, 300) + `... (${bodyText.length - 300} more chars)`
        : bodyText;

      // Attempt to parse the body up-front. Successful JSON parse + a body that
      // doesn't look like an Akamai error envelope is strong evidence of success
      // and lets us recover when statusCode is missing/0 from the library.
      let parsed: any = null;
      let parseError: Error | null = null;
      try {
        parsed = typeof body === 'string' ? JSON.parse(body) : body;
      } catch (parseErr: any) {
        parseError = parseErr;
      }

      const looksLikeAkamaiError =
        parsed && typeof parsed === 'object' &&
        ('type' in parsed || 'errors' in parsed) &&
        ('title' in parsed || 'detail' in parsed || 'status' in parsed);

      // Decide effective status:
      //  - If we got a number from the library, trust it.
      //  - Else if body parsed and isn't an error envelope, treat as 200.
      //  - Else 0 (forces failure path with the body preview).
      let effectiveStatus: number;
      if (typeof rawStatus === 'number' && rawStatus > 0) {
        effectiveStatus = rawStatus;
      } else if (parsed && !looksLikeAkamaiError && !parseError) {
        effectiveStatus = 200;
        console.log(`[Akamai] ${method} ${path}: library returned status=${rawStatus ?? 'undefined'} but body parses cleanly — treating as 200`);
      } else {
        effectiveStatus = 0;
      }

      console.log(`[Akamai] ${method} ${path} → ${effectiveStatus} in ${elapsedMs}ms (${bodyText?.length ?? 0} bytes)`);

      if (effectiveStatus < 200 || effectiveStatus >= 300) {
        console.error(`[Akamai] non-2xx body preview: ${preview}`);
        return reject(new Error(`Akamai PAPI returned ${effectiveStatus}: ${preview}`));
      }

      if (parseError) {
        console.error(`[Akamai] failed to parse response body as JSON: ${parseError.message}`);
        return reject(new Error(`Akamai response was not valid JSON: ${parseError.message}`));
      }

      resolve(parsed as T);
    });
  });
}

// ── Generic TTL caches ───────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Lazy-load with TTL cache (single-value variant). Calls `loader` on
 * first invocation or when cache is expired; subsequent calls within
 * TTL return the cached value via resolved Promise.
 *
 * If multiple concurrent callers arrive while the cache is empty/expired,
 * they all share the same in-flight Promise — no thundering herd.
 */
function makeTtlCache<T>(loader: () => Promise<T>, ttlMs: number, label: string) {
  let entry: CacheEntry<T> | null = null;
  let inflight: Promise<T> | null = null;

  return async function get(): Promise<T> {
    const now = Date.now();
    if (entry && entry.expiresAt > now) {
      console.log(`[Akamai/cache] ${label}: HIT (expires in ${Math.round((entry.expiresAt - now) / 1000)}s)`);
      return entry.value;
    }
    if (inflight) {
      console.log(`[Akamai/cache] ${label}: waiting on in-flight load`);
      return inflight;
    }

    console.log(`[Akamai/cache] ${label}: MISS — loading`);
    inflight = loader().then(value => {
      entry = { value, expiresAt: Date.now() + ttlMs };
      inflight = null;
      console.log(`[Akamai/cache] ${label}: cached for ${Math.round(ttlMs / 1000)}s`);
      return value;
    }).catch(err => {
      // Don't poison the cache with the error; just clear inflight so
      // the next caller retries.
      inflight = null;
      throw err;
    });
    return inflight;
  };
}

/**
 * Lazy-load with TTL cache, keyed variant. Same semantics as
 * makeTtlCache but each cache key has its own entry and its own
 * in-flight de-duplication.
 *
 * The keyFn turns the loader's input args into a string cache key.
 * Used for getRuleTree(propertyId, version) where the cache key is
 * "{propertyId}:{version}".
 */
function makeKeyedTtlCache<Args extends unknown[], V>(
  loader: (...args: Args) => Promise<V>,
  keyFn: (...args: Args) => string,
  ttlMs: number,
  label: string
) {
  const entries = new Map<string, CacheEntry<V>>();
  const inflight = new Map<string, Promise<V>>();

  return async function get(...args: Args): Promise<V> {
    const key = keyFn(...args);
    const now = Date.now();

    const existing = entries.get(key);
    if (existing && existing.expiresAt > now) {
      console.log(`[Akamai/cache] ${label}[${key}]: HIT (expires in ${Math.round((existing.expiresAt - now) / 1000)}s)`);
      return existing.value;
    }
    const pending = inflight.get(key);
    if (pending) {
      console.log(`[Akamai/cache] ${label}[${key}]: waiting on in-flight load`);
      return pending;
    }

    console.log(`[Akamai/cache] ${label}[${key}]: MISS — loading`);
    const promise = loader(...args).then(value => {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      inflight.delete(key);
      console.log(`[Akamai/cache] ${label}[${key}]: cached for ${Math.round(ttlMs / 1000)}s`);
      return value;
    }).catch(err => {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, promise);
    return promise;
  };
}

// ── Public service API ──────────────────────────────────────────────

/**
 * Internal: fetches the monitored property list from PAPI without
 * caching. Caller (the cache wrapper) decides when to invoke this.
 *
 * Reads AKAMAI_PROPERTY_IDS from env, fetches each property's metadata
 * from PAPI, filters out properties without a production version.
 */
async function fetchMonitoredProperties(): Promise<MonitoredProperty[]> {
  const raw = process.env.AKAMAI_PROPERTY_IDS || '';
  const contractId = process.env.AKAMAI_DEFAULT_CONTRACT_ID;
  const groupId = process.env.AKAMAI_DEFAULT_GROUP_ID;

  console.log(`[Akamai] fetchMonitoredProperties() — AKAMAI_PROPERTY_IDS=${raw ? raw : 'MISSING'}`);
  console.log(`[Akamai] env: AKAMAI_DEFAULT_CONTRACT_ID=${contractId || 'MISSING'}, AKAMAI_DEFAULT_GROUP_ID=${groupId || 'MISSING'}`);

  if (!raw.trim()) {
    throw new Error('AKAMAI_PROPERTY_IDS is not set in .env (comma-separated allowlist of prp_XXXXXX ids)');
  }
  if (!contractId) throw new Error('AKAMAI_DEFAULT_CONTRACT_ID is not set in .env');
  if (!groupId) throw new Error('AKAMAI_DEFAULT_GROUP_ID is not set in .env');

  // Preserve env-var order — first-match-wins on hostname collisions
  // depends on this ordering being stable.
  const propertyIds = raw.split(',').map(s => s.trim()).filter(Boolean);

  const results: MonitoredProperty[] = [];

  // Sequential rather than parallel: PAPI is rate-limited, and the
  // expected count is small (a handful of properties). Sequential keeps
  // logs readable and avoids burst rate-limit issues.
  for (const propertyId of propertyIds) {
    try {
      const response = await edgeRequest<{ properties: { items: PapiPropertyRecord[] } }>(
        'GET',
        `/papi/v1/properties/${propertyId}`,
        { contractId, groupId }
      );

      const record = response.properties?.items?.[0];
      if (!record) {
        console.warn(`[Akamai] propertyId=${propertyId} returned empty items array — skipping`);
        continue;
      }

      if (record.productionVersion === null || record.productionVersion === undefined) {
        console.warn(`[Akamai] propertyId=${propertyId} (${record.propertyName}) has no production version — skipping`);
        continue;
      }

      results.push({
        propertyId: record.propertyId,
        propertyName: record.propertyName,
        contractId: record.contractId,
        groupId: record.groupId,
        version: record.productionVersion,
        latestVersion: record.latestVersion
      });

      console.log(`[Akamai] monitored: ${record.propertyName} (${record.propertyId} v${record.productionVersion})`);
    } catch (err: any) {
      console.error(`[Akamai] failed to fetch propertyId=${propertyId}: ${err.message}`);
    }
  }

  console.log(`[Akamai] fetchMonitoredProperties() returning ${results.length} of ${propertyIds.length} configured properties`);
  return results;
}

/**
 * Cached accessor for monitored properties. First call triggers PAPI
 * fetches; subsequent calls within TTL return the cached value.
 */
export const listMonitoredProperties = makeTtlCache(
  fetchMonitoredProperties,
  CACHE_TTL_MS,
  'monitored-properties'
);

/**
 * Internal: builds the hostname → property map from the monitored
 * property list. For each monitored property, fetches its hostnames at
 * the active production version and registers each cnameFrom in the
 * lookup map.
 *
 * Hostnames are stored lowercase. On collision (the same hostname
 * appears on multiple properties) the FIRST occurrence wins, where
 * "first" follows the order of AKAMAI_PROPERTY_IDS in .env. The
 * collision is logged with both property IDs.
 */
async function fetchHostnameMap(): Promise<Map<string, HostnameMatch>> {
  console.log(`[Akamai] fetchHostnameMap() — building`);
  const properties = await listMonitoredProperties();
  const map = new Map<string, HostnameMatch>();

  // Iterate in property-list order so first-match-wins is deterministic.
  for (const prop of properties) {
    try {
      const response = await edgeRequest<{ hostnames: { items: PapiHostnameItem[] } }>(
        'GET',
        `/papi/v1/properties/${prop.propertyId}/versions/${prop.version}/hostnames`,
        { contractId: prop.contractId, groupId: prop.groupId }
      );

      const items = response.hostnames?.items || [];

      for (const item of items) {
        if (!item.cnameFrom) continue;
        const key = item.cnameFrom.toLowerCase();

        const existing = map.get(key);
        if (existing) {
          // Collision: keep the earlier entry, log both for visibility.
          console.warn(
            `[Akamai] hostname collision: "${item.cnameFrom}" appears on both ` +
            `${existing.propertyName} (${existing.propertyId}) and ` +
            `${prop.propertyName} (${prop.propertyId}) — keeping first (env-var order)`
          );
          continue;
        }

        map.set(key, {
          hostname: item.cnameFrom,
          propertyId: prop.propertyId,
          propertyName: prop.propertyName,
          contractId: prop.contractId,
          groupId: prop.groupId,
          version: prop.version
        });
      }

      console.log(`[Akamai] ${prop.propertyName} (${prop.propertyId} v${prop.version}): ${items.length} hostnames`);
    } catch (err: any) {
      console.error(`[Akamai] failed to fetch hostnames for ${prop.propertyId}: ${err.message}`);
    }
  }

  console.log(`[Akamai] fetchHostnameMap() built map with ${map.size} hostnames across ${properties.length} properties`);
  return map;
}

/**
 * Cached accessor for the hostname map. First call (or first call after
 * TTL expiry) triggers a full rebuild; subsequent calls within TTL
 * return the cached map.
 */
export const getHostnameMap = makeTtlCache(
  fetchHostnameMap,
  CACHE_TTL_MS,
  'hostname-map'
);

/**
 * Resolves an input hostname (case-insensitive exact match) to its
 * monitored property. Returns null if the hostname is not on any
 * configured property.
 *
 * Callers should treat null as a user-facing error condition and
 * include sample configured hostnames in the error response.
 */
export async function resolveHostname(hostname: string): Promise<HostnameMatch | null> {
  if (!hostname) return null;
  const map = await getHostnameMap();
  const match = map.get(hostname.toLowerCase());
  if (!match) {
    console.log(`[Akamai] resolveHostname("${hostname}"): no match (${map.size} hostnames in map)`);
    return null;
  }
  console.log(`[Akamai] resolveHostname("${hostname}"): matched ${match.propertyName} (${match.propertyId} v${match.version})`);
  return match;
}

/**
 * Returns a sample of configured hostnames for use in user-facing error
 * messages when resolveHostname() returns null. Caps at maxCount entries
 * to keep error responses readable.
 */
export async function getConfiguredHostnamesSample(maxCount: number = 10): Promise<string[]> {
  const map = await getHostnameMap();
  const all: string[] = [];
  for (const match of map.values()) {
    all.push(match.hostname);
    if (all.length >= maxCount) break;
  }
  return all;
}

/**
 * Internal: fetches the rule tree for a specific property version
 * directly from PAPI, no caching. Caller (the cache wrapper) decides
 * when to invoke this.
 *
 * Resolves contract/group from the monitored properties cache rather
 * than re-passing them, so the caller only needs (propertyId, version).
 * If propertyId is not in the monitored set, throws — this prevents
 * arbitrary properties being queried via the rule tree endpoint.
 */
async function fetchRuleTree(propertyId: string, version: number): Promise<PropertyRuleTree> {
  console.log(`[Akamai] fetchRuleTree(${propertyId}, v${version})`);

  // Look up the property in the monitored set to get contract/group
  // and propertyName (for the response). This also enforces the
  // allowlist — we never fetch rule trees for properties outside
  // AKAMAI_PROPERTY_IDS.
  const properties = await listMonitoredProperties();
  const prop = properties.find(p => p.propertyId === propertyId);
  if (!prop) {
    throw new Error(`propertyId=${propertyId} is not in the monitored property allowlist (AKAMAI_PROPERTY_IDS)`);
  }

  const response = await edgeRequest<PapiRuleTreeResponse>(
    'GET',
    `/papi/v1/properties/${propertyId}/versions/${version}/rules`,
    {
      contractId: prop.contractId,
      groupId: prop.groupId,
      validateRules: 'false'
    }
  );

  if (!response.rules) {
    throw new Error(`PAPI rule tree response for ${propertyId} v${version} has no 'rules' field`);
  }

  return {
    propertyId: response.propertyId || propertyId,
    propertyName: response.propertyName || prop.propertyName,
    version: response.propertyVersion || version,
    etag: response.etag,
    ruleFormat: response.ruleFormat,
    rules: response.rules
  };
}

/**
 * Cached accessor for a property's rule tree at a specific version.
 *
 * Cache key is "{propertyId}:{version}". Each (propertyId, version)
 * pair has its own 10-minute entry. Different versions of the same
 * property are cached independently — useful if a property is being
 * actively redeployed, since old version data won't shadow new data.
 */
export const getRuleTree = makeKeyedTtlCache(
  fetchRuleTree,
  (propertyId: string, version: number) => `${propertyId}:${version}`,
  RULE_TREE_TTL_MS,
  'rule-tree'
);

// ── End-to-end orchestration ────────────────────────────────────────

/**
 * Result of an end-to-end URL evaluation. Returned by evaluateUrl()
 * for the success path. Hostname-not-found and parse errors are
 * communicated via thrown EvaluateUrlError instances so the route
 * layer can map them to the correct HTTP status.
 */
export interface EvaluateUrlResult {
  /** The original URL string the user submitted. */
  url: string;
  /** The parsed components used by the matcher. */
  parsedUrl: ParsedRequestUrl;
  /** Identifying metadata for the property the URL resolved to. */
  property: {
    propertyId: string;
    propertyName: string;
    version: number;
  };
  /** Final path after applying the matched rewriteUrl behaviors in order. */
  destinationPath: string;
  /** True when destinationPath differs from parsedUrl.path. */
  pathChanged: boolean;
  /** Ordered request-to-origin flow (spine + conditional branches). */
  flow: FlowHop[];
  /** Full backend URL the request lands on: origin host + destination path + query. Null when the origin can't be resolved concretely. */
  backendEndpoint: string | null;
}

/**
 * Error class for evaluateUrl()'s expected failure modes. Carries an
 * HTTP-style status the route layer can pass straight to res.status().
 *
 * Unexpected errors (e.g. PAPI 5xx, library bugs) propagate as plain
 * Error instances and route to 500 in the handler.
 */
export class EvaluateUrlError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EvaluateUrlError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Full pipeline: parse URL → resolve hostname → fetch rule tree →
 * extract baseline → run matcher → return structured result.
 *
 * This is the single function that backs both POST /api/akamai/flow
 * (the real endpoint) and GET /_debug/match (the diagnostic). Keeping
 * one orchestrator means the diagnostic and the real endpoint are
 * guaranteed to behave identically — if /_debug/match works, /flow
 * works.
 *
 * Throws EvaluateUrlError(400) if the URL is malformed.
 * Throws EvaluateUrlError(404) if the hostname is not configured on
 * any monitored property. The error's `details` field contains a
 * sample of configured hostnames for use in the response body.
 * Other errors propagate (route layer renders 500).
 */
export interface EvaluateUrlOptions {
  /** Blue/green colour selector (blue|green|standard). */
  colour?: string;
  /** Site/env selector (e.g. "qa1"). */
  site?: string;
  /** Drop the Shape routing subtree (unused in practice). */
  suppressShape?: boolean;
}

/** Collects declared PM-variable defaults from the root rule for seeding. */
function extractVariableDefaults(rootRule: AkamaiRule): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of rootRule.variables || []) {
    if (v && typeof v.name === 'string') {
      out[v.name] = typeof v.value === 'string' ? v.value : '';
    }
  }
  return out;
}

export async function evaluateUrl(urlString: string, options: EvaluateUrlOptions = {}): Promise<EvaluateUrlResult> {
  console.log(`[Akamai] evaluateUrl("${urlString}")`);

  const parsed = parseRequestUrl(urlString);
  if (!parsed) {
    throw new EvaluateUrlError(
      400,
      `Could not parse URL "${urlString}". Provide a full URL including scheme (https://) and host.`,
      { url: urlString }
    );
  }

  const match = await resolveHostname(parsed.hostname);
  if (!match) {
    const hostnameMap = await getHostnameMap();
    const sample = Array.from(hostnameMap.values())
      .slice(0, 10)
      .map(m => m.hostname);
    throw new EvaluateUrlError(
      404,
      `Hostname "${parsed.hostname}" is not configured on any monitored property`,
      {
        url: urlString,
        parsedUrl: parsed,
        configuredHostnameCount: hostnameMap.size,
        configuredHostnamesSample: sample
      }
    );
  }

  const ruleTree = await getRuleTree(match.propertyId, match.version);

  // Hostname decides cloudlet involvement + supplies/locks colour & site.
  // GSS hosts need the user's pick; colour-prefixed and plain hosts don't.
  const hostClass = classifyHostname(parsed.hostname);
  const effectiveColour = hostClass.colourPrefix || options.colour;
  const effectiveSite = hostClass.specificSite || options.site;
  const datacenter = resolveDatacenter(hostClass, effectiveSite);

  const { matchedRules, vars } = matchUrl(ruleTree.rules, parsed, {
    colour: effectiveColour,
    site: effectiveSite,
    isCloudletUrl: hostClass.isCloudletUrl,
    suppressShape: options.suppressShape,
    variableDefaults: extractVariableDefaults(ruleTree.rules)
  });

  const { destinationPath, pathChanged, flow } = resolveFlow(matchedRules, parsed, {
    propertyName: ruleTree.propertyName,
    version: ruleTree.version
  });

  // Replace any {{user.PMUSER_TARGET}} origin with the concrete host for the
  // selected datacenter + computed origin type, read from the config's own
  // setVariable literals (handles BOS / CMS / ISAM targets).
  const targetHost = resolvePmuserTarget(matchedRules, datacenter, originTypeOf(vars));
  if (targetHost) interpolateFlow(flow, { PMUSER_TARGET: targetHost });

  const backendEndpoint = buildBackendEndpoint(flow, destinationPath, parsed.query);

  console.log(`[Akamai] evaluateUrl("${urlString}"): ${parsed.path} → ${destinationPath} (${flow.length} hops) on ${ruleTree.propertyName} v${ruleTree.version}`);

  return {
    url: urlString,
    parsedUrl: parsed,
    property: {
      propertyId: ruleTree.propertyId,
      propertyName: ruleTree.propertyName,
      version: ruleTree.version
    },
    destinationPath,
    pathChanged,
    flow,
    backendEndpoint
  };
}

// ── Blue/green target resolution ────────────────────────────────────

/**
 * Within a GSS pair the lower site is BCC, the higher is SCC. Returns the
 * datacenter for the chosen site, or undefined for non-GSS hosts.
 */
function resolveDatacenter(hostClass: HostnameClass, site?: string): 'BCC' | 'SCC' | undefined {
  if (!hostClass.gssPair || !site) return undefined;
  if (site === hostClass.pairSites[0]) return 'BCC';
  if (site === hostClass.pairSites[1]) return 'SCC';
  return undefined;
}

/** Maps PMUSER_ORIGINTYPE state to the target host family. */
function originTypeOf(vars: Record<string, string>): string {
  const t = (vars['PMUSER_ORIGINTYPE'] || '').toUpperCase();
  if (t === 'CMS') return 'CMS';
  if (t === 'ISAM') return 'ISAM';
  return 'BOS';
}

/** Classifies a concrete target host into its origin-type family. */
function hostTypeOf(host: string): string {
  const lo = host.toLowerCase();
  if (lo.includes('harrismycfo')) return 'CMS';
  if (lo.includes('retailcanapi')) return 'ISAM';
  return 'BOS';
}

/**
 * Reads the concrete PMUSER_TARGET host from the config's own setVariable
 * literals among the matched rules, choosing by datacenter (BCC/SCC, from
 * the rule's stickiness cookie) and origin type (from the host family).
 * Returns undefined when nothing suitable is found (origin stays symbolic).
 */
function resolvePmuserTarget(
  matchedRules: MatchedRule[],
  datacenter: 'BCC' | 'SCC' | undefined,
  originType: string
): string | undefined {
  const candidates: { dc?: string; type: string; host: string }[] = [];
  for (const rule of matchedRules) {
    for (const behavior of rule.behaviors) {
      const o = behavior.options || {};
      if (behavior.name !== 'setVariable' || o.variableName !== 'PMUSER_TARGET') continue;
      if (o.valueSource !== 'EXPRESSION') continue;
      const host = typeof o.variableValue === 'string' ? o.variableValue : '';
      if (!host || host.includes('{{')) continue;

      let dc: string | undefined;
      for (const criterion of rule.criteria) {
        if (criterion.name !== 'requestCookie') continue;
        const blob = JSON.stringify(criterion.options || {}).toUpperCase();
        if (blob.includes('BCC')) dc = 'BCC';
        else if (blob.includes('SCC')) dc = 'SCC';
      }
      candidates.push({ dc, type: hostTypeOf(host), host });
    }
  }

  const byType = candidates.filter(c => c.type === originType);
  return (
    byType.find(c => c.dc === datacenter)?.host ||
    byType.find(c => !c.dc)?.host ||
    candidates.find(c => c.dc === datacenter)?.host ||
    undefined
  );
}

/** Substitutes {{user.X}} tokens in flow hop details and branch labels. */
function interpolateFlow(flow: FlowHop[], values: Record<string, string>): void {
  const sub = (s: string): string =>
    s.replace(/\{\{user\.([A-Za-z0-9_]+)\}\}/g, (m, name) => values[String(name).toUpperCase()] ?? m);
  for (const hop of flow) {
    hop.detail = sub(hop.detail);
    for (const branch of hop.branches) branch.targetLabel = sub(branch.targetLabel);
  }
}

/**
 * Builds the full backend URL the request lands on: scheme + origin host +
 * destination path + query. Returns null when the origin isn't a concrete
 * host (default/unchanged, or an unresolved {{user.*}} target).
 */
function buildBackendEndpoint(flow: FlowHop[], destinationPath: string, query: string): string | null {
  const origin = flow.find(h => h.kind === 'origin');
  const host = origin ? origin.detail : '';
  if (!host || host.startsWith('(') || host.includes('{{')) return null;
  return `https://${host}${destinationPath}${query ? '?' + query : ''}`;
}
