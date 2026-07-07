import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import config from '../config';

// ── Types ────────────────────────────────────────────────────────────

interface EnvConfigEntry {
  url: string | undefined;
  token: string | undefined;
}

interface ResolvedEnvConfig {
  url: string;
  token: string;
}

interface Timeframe {
  from: string;
  to: string;
}

interface DynatraceExecuteResponse {
  state: string;
  requestToken: string;
  ttlSeconds?: number;
}

interface DynatracePollResponse {
  state: string;
  progress?: number;
  result: {
    records: Record<string, unknown>[];
    types?: unknown[];
  };
}

interface TraceMatch {
  traceId: string;
  startTime: string;
  endpoint: string;
  service: string;
  serverAddress: string;
  httpStatus: string;
  isFailed: boolean;
  hasExceptions: boolean;
  exceptionCount: number;
  duration: number;
}

interface EndpointMatch {
  method: string;
  urlPath: string;
  service: string;
  serverAddress: string;
  count: number;
  lastSeen: string;
}

// ── Constants ────────────────────────────────────────────────────────

const ENV_CONFIG: Record<string, EnvConfigEntry> = {
  'NON-PROD': {
    url: process.env.DYNATRACE_NONPROD_API_URL,
    token: process.env.DYNATRACE_NONPROD_TOKEN
  },
  'PRE-PROD': {
    url: process.env.DYNATRACE_PREP_API_URL,
    token: process.env.DYNATRACE_PREP_TOKEN
  },
  'PROD': {
    url: process.env.DYNATRACE_PROD_API_URL,
    token: process.env.DYNATRACE_PROD_TOKEN
  }
};

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60;
const MOCK_FILE_PATH = path.join(__dirname, '..', 'mocks', 'trace-sample.json');

// ── Proxy setup ──────────────────────────────────────────────────────
// Only activated when PROXY_TARGET is configured. Uses Dynatrace-specific
// proxy credentials (DYNATRACE_PROXY_USERNAME / DYNATRACE_PROXY_PASSWORD)
// if set, otherwise falls back to shared proxy credentials. This allows
// a different account for Dynatrace without affecting other services.

const proxyAgent: HttpsProxyAgent<string> | null = (() => {
  const target = config.proxy?.target;
  if (!target) return null;

  const username = process.env.DYNATRACE_PROXY_USERNAME || config.proxy.username || '';
  const password = process.env.DYNATRACE_PROXY_PASSWORD || config.proxy.password || '';
  const proxyUrl = `http://${username}:${password}@${target}`;
  return new HttpsProxyAgent(proxyUrl);
})();

/** Axios instance for Dynatrace API calls. Routes through the corporate proxy when configured. */
const httpClient = axios.create({
  ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
});

// ── DQL Query Builders ───────────────────────────────────────────────

function buildRequestIdLookupQuery(requestId: string, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  return [
    `fetch spans, ${timeframeClause}, samplingRatio: 1, scanLimitGBytes: 500`,
    `| filter matchesValue(\`http.request.header.x-request-id\`, "${requestId}")`,
    `| fields trace.id`,
    `| limit 1`
  ].join('\n');
}

/**
 * Parses a user-supplied URL into a hostname and path. Accepts:
 *   - Full URLs with scheme: "https://host.com/foo"
 *   - Host + path without scheme: "host.com/foo"
 *   - Hostname only: "host.com"
 *   - Absolute path only: "/banking/services/foo"
 *   - Relative path fragments: "banking/services/foo", "verifyCredential"
 *
 * Disambiguation rule: when there's no scheme, the first segment is
 * treated as a hostname only if it contains a dot (e.g. "host.com",
 * "api.bmogc.net"). Otherwise the entire input is treated as a path
 * fragment.
 */
function parseUrl(url: string): { host: string; path: string } {
  if (!url || typeof url !== 'string') return { host: '', path: '' };

  const trimmed = url.trim();
  const hadScheme = /^https?:\/\//i.test(trimmed);
  const remainder = trimmed.replace(/^https?:\/\//i, '');

  const firstSlash = remainder.indexOf('/');
  const firstSegment = firstSlash === -1 ? remainder : remainder.substring(0, firstSlash);

  if (!hadScheme && !firstSegment.includes('.')) {
    return { host: '', path: remainder };
  }

  let host = '';
  let urlPath = '';
  if (firstSlash === -1) {
    host = remainder;
  } else {
    host = remainder.substring(0, firstSlash);
    urlPath = remainder.substring(firstSlash).replace(/^\/+/, '/');
  }

  return { host, path: urlPath };
}

function buildUrlSearchFilters(host: string, urlPath: string, hostExact: boolean = false): string[] {
  const filters: string[] = [];
  if (urlPath) {
    filters.push(`| filter contains(lower(url.path), lower("${urlPath}"))`);
  }
  if (host) {
    if (hostExact) {
      filters.push(`| filter server.address == "${host}"`);
    } else {
      filters.push(`| filter contains(lower(server.address), lower("${host}"))`);
    }
  }
  return filters;
}

/**
 * Normalizes a user-supplied client IPv4 address to its Dynatrace-masked
 * form. Dynatrace's ID masking zeroes the last octet of captured client
 * IPs (e.g. 24.157.71.45 is stored as 24.157.71.0), so searches must use
 * the masked value. Idempotent for already-masked input.
 */
export function normalizeClientIp(input: string): string {
  const trimmed = (input || '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (!match) {
    throw new Error('Invalid client IP. Enter an IPv4 address like 24.157.71.45.');
  }
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

/**
 * Filter on the CDB ClientIP request attribute. Mirrors the filter the
 * Dynatrace Distributed Tracing UI generates for this attribute: the
 * attribute may be stored as a string or an ip type, scalar or array,
 * so all four shapes are OR'd together.
 */
function buildClientIpFilter(maskedIp: string): string {
  const field = '`request_attribute.ReqAttr.CDB.ClientIP`';
  return `| filter (${field} == "${maskedIp}"`
    + ` or iAny(matchesValue(toArray(${field})[], "${maskedIp}"))`
    + ` or ${field} == toIp("${maskedIp}")`
    + ` or iAny(toArray(${field})[] == toIp("${maskedIp}")))`;
}

/** Shared trace-match query shape: applies the given filter lines, then summarizes spans into one row per trace. */
function buildTraceMatchQuery(filterLines: string[], timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    ...filterLines,
    `| fieldsAdd _kindRank = if(span.kind == "server", 0, else: 1)`,
    `| sort _kindRank asc`,
    `| summarize {`,
    `    startTime = takeMin(start_time),`,
    `    endpoint = takeFirst(endpoint.name),`,
    `    service = takeFirst(dt.service.name),`,
    `    serverAddress = takeFirst(server.address),`,
    `    httpStatus = takeFirst(http.response.status_code),`,
    `    isFailed = countIf(request.is_failed == true) > 0,`,
    `    duration = takeFirst(duration)`,
    `  }, by: { trace.id }`,
    `| sort startTime desc`,
    `| limit 100`
  ].join('\n');
}

/**
 * Unique-endpoint query: applies the given URL filter lines, then
 * summarizes spans into one row per (url.path, http.request.method)
 * pair. Sorted alphabetically by path (method as tiebreaker) so
 * attestation scans are stable and predictable across runs.
 */
function buildEndpointSearchQuery(filterLines: string[], timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    ...filterLines,
    `| filter isNotNull(url.path)`,
    `| summarize {`,
    `    count = count(),`,
    `    lastSeen = takeMax(start_time),`,
    `    service = takeFirst(dt.service.name),`,
    `    serverAddress = takeFirst(server.address)`,
    `  }, by: { url.path, http.request.method }`,
    `| sort url.path asc, http.request.method asc`,
    `| limit 10000`
  ].join('\n');
}

/**
 * Replaces ID-like path segments with "{id}" so URL variants collapse
 * into one logical endpoint (e.g. statementSummary/R1008 and
 * statementSummary/R101 both become statementSummary/{id}).
 *
 * A segment is treated as an ID when it is:
 *   - all digits (12345)
 *   - a UUID
 *   - a hex string of 8+ chars (trace/session tokens)
 *   - 1-3 letters followed only by digits (R2, R10, R1008, ABC123),
 *     except version tokens (v1, v2, V10) which stay literal
 *   - contains 3 or more digits (card refs)
 * The 3-digit threshold deliberately spares segments like oauth2
 * and 2fa.
 */
function normalizeUrlPath(rawPath: string): string {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_RE = /^[0-9a-f]{8,}$/i;
  const ALL_DIGITS_RE = /^\d+$/;
  const LETTER_PREFIX_ID_RE = /^[a-z]{1,3}\d+$/i;
  const VERSION_RE = /^v\d+$/i;

  const looksLikeId = (segment: string): boolean => {
    if (ALL_DIGITS_RE.test(segment)) return true;
    if (UUID_RE.test(segment)) return true;
    if (HEX_RE.test(segment)) return true;
    if (LETTER_PREFIX_ID_RE.test(segment) && !VERSION_RE.test(segment)) return true;
    const digitCount = (segment.match(/\d/g) || []).length;
    return digitCount >= 3;
  };

  return rawPath
    .split('/')
    .map(segment => (segment && looksLikeId(segment)) ? '{id}' : segment)
    .join('/');
}

/**
 * Latest-trace lookup for a logical endpoint from the endpoint search.
 * Normalized paths may contain "{id}" placeholders which match nothing
 * in Dynatrace, so when present the filter falls back to contains() on
 * the prefix up to the first "{id}" segment — covering all variants of
 * the group. Exact paths use an exact match.
 */
function buildLatestTraceQuery(urlPath: string, method: string, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const idIndex = urlPath.indexOf('{id}');
  const pathFilter = idIndex === -1
    ? `| filter url.path == "${urlPath}"`
    : `| filter contains(lower(url.path), lower("${urlPath.substring(0, idIndex)}"))`;

  const filters = [pathFilter];
  if (method) {
    filters.push(`| filter http.request.method == "${method}"`);
  }

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    ...filters,
    `| sort start_time desc`,
    `| fields trace.id`,
    `| limit 1`
  ].join('\n');
}

function buildSessionQuery(sessionId: string, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -2h';

  return [
    `fetch user.events, ${timeframeClause}, scanLimitGBytes: 500`,
    `| filter dt.rum.session.id == "${sessionId}"`,
    `| sort start_time asc`,
    `| limit 5000`
  ].join('\n');
}

/**
 * Builds a DQL query that checks for exceptions across ALL spans in the
 * given trace IDs — not just the spans that matched the URL filters.
 *
 * The URL search query's hasExceptions was unreliable because it only
 * counted span.events on spans matching the URL filters. Exceptions often
 * live on downstream/internal spans that don't match the searched URL.
 * This second-pass query scans all spans for the specific trace IDs and
 * returns which ones have exception events.
 */
function buildExceptionCheckQuery(traceIds: string[], timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const uidList = traceIds.map(id => `toUid("${id}")`).join(', ');

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    `| filter in(trace.id, {${uidList}})`,
    `| filter isNotNull(span.events) and arraySize(span.events) > 0`,
    `| summarize { exceptionCount = count() }, by: { trace.id }`,
  ].join('\n');
}

function buildDqlQuery(traceId: string, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const parts = [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 5000`,
    `| filter in(trace.id, {toUid("${traceId}")})`,
    `| limit 1000`,
    `| fieldsAdd span.source = if((isNotNull(dt.agent.module.id)) or matchesValue(telemetry.exporter.name, "odin") or matchesValue(telemetry.sdk.name, "oneagent") or matchesValue(dt.openpipeline.source, "oneagent"), "OneAgent", else: "OpenTelemetry")`,
    `| fieldsAdd icon = entityAttr(dt.entity.service, "icon")`,
    `| fieldsAdd dt.entity.service.entity.name = entityAttr(dt.entity.service, "entity.name")`,
    `| fieldsAdd dt.entity.host.entity.name = entityAttr(dt.entity.host, "entity.name")`,
    `| fieldsAdd dt.entity.process_group.entity.name = entityAttr(dt.entity.process_group, "entity.name")`,
    `| fieldsAdd dt.entity.process_group_instance.entity.name = entityAttr(dt.entity.process_group_instance, "entity.name")`
  ];

  return parts.join('\n');
}

// ── Core Dynatrace API helpers ───────────────────────────────────────

function getEnvConfig(environment: string = 'NON-PROD', userToken: string | null = null): ResolvedEnvConfig {
  const config = ENV_CONFIG[environment.toUpperCase()];
  if (!config || !config.url) {
    throw new Error(`Invalid or missing Dynatrace URL configuration for environment: ${environment}`);
  }

  const token = userToken || config.token;
  if (!token) {
    throw new Error(`No Dynatrace token available for environment: ${environment}. Please provide a token in settings.`);
  }

  return {
    url: config.url.replace(/\/+$/, ''),
    token
  };
}

/**
 * Optional result-size limits for the Grail query API. The execute
 * endpoint defaults to ~1,000 records / ~1 MB regardless of the DQL
 * "| limit" clause, so queries expecting large result sets must raise
 * these explicitly in the request body.
 */
interface QueryExecuteOptions {
  maxResultRecords?: number;
  maxResultBytes?: number;
}

async function executeQuery(config: ResolvedEnvConfig, query: string, options?: QueryExecuteOptions): Promise<string> {
  const executeUrl = `${config.url}/query:execute`;

  const response = await httpClient.post<DynatraceExecuteResponse>(
    executeUrl,
    {
      query,
      defaultTimeframeStart: null,
      defaultTimeframeEnd: null,
      ...(options?.maxResultRecords && { maxResultRecords: options.maxResultRecords }),
      ...(options?.maxResultBytes && { maxResultBytes: options.maxResultBytes })
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`
      }
    }
  );

  if (!response.data || !response.data.requestToken) {
    throw new Error('Dynatrace execute response missing requestToken');
  }

  return response.data.requestToken;
}

async function pollForResults(config: ResolvedEnvConfig, requestToken: string): Promise<DynatracePollResponse> {
  const pollUrl = `${config.url}/query:poll`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const response = await httpClient.get<DynatracePollResponse>(
      pollUrl,
      {
        params: { 'request-token': requestToken },
        headers: {
          'Authorization': `Bearer ${config.token}`
        }
      }
    );

    const { state } = response.data;

    if (state === 'SUCCEEDED') {
      return response.data;
    }

    if (state !== 'RUNNING') {
      throw new Error(`Dynatrace query failed with state: ${state}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Dynatrace query timed out after ${MAX_POLL_ATTEMPTS} poll attempts`);
}

function loadMockResponse(): DynatracePollResponse {
  if (!fs.existsSync(MOCK_FILE_PATH)) {
    throw new Error(`Mock file not found at: ${MOCK_FILE_PATH}`);
  }
  const content = fs.readFileSync(MOCK_FILE_PATH, 'utf8');
  return JSON.parse(content);
}

function loadMockTraceMatches(): TraceMatch[] {
  const mock = loadMockResponse();
  const first = (mock.result?.records || [])[0];
  if (!first) return [];
  return [{
    traceId: (first['trace.id'] as string) || '',
    startTime: (first['start_time'] as string) || '',
    endpoint: (first['endpoint.name'] as string) || '',
    service: (first['dt.service.name'] as string) || '',
    serverAddress: (first['server.address'] as string) || '',
    httpStatus: String(first['http.response.status_code'] || ''),
    isFailed: first['request.is_failed'] === true,
    hasExceptions: false,
    exceptionCount: 0,
    duration: Number(first['duration']) || 0
  }];
}

/**
 * Runs a trace-match search: executes the shared summarize-by-trace query
 * with the given filter lines, maps records to TraceMatch, then runs the
 * second-pass exception check across all spans in the matched traces.
 * Shared by URL search and Client IP search (single source of truth).
 */
async function runTraceMatchSearch(
  config: ResolvedEnvConfig,
  filterLines: string[],
  timeframe?: Timeframe
): Promise<TraceMatch[]> {
  const query = buildTraceMatchQuery(filterLines, timeframe);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  const records = result.result?.records || [];

  const results: TraceMatch[] = records.map(r => ({
    traceId: (r['trace.id'] as string) || '',
    startTime: (r['startTime'] as string) || '',
    endpoint: (r['endpoint'] as string) || '',
    service: (r['service'] as string) || '',
    serverAddress: (r['serverAddress'] as string) || '',
    httpStatus: String(r['httpStatus'] || ''),
    isFailed: r['isFailed'] === true,
    hasExceptions: false,
    exceptionCount: 0,
    duration: Number(r['duration']) || 0
  }));

  // Second-pass: check for exceptions across ALL spans in the matched
  // trace IDs. The trace-match query only sees spans matching the search
  // filters, so exceptions on downstream/internal spans get missed.
  if (results.length > 0) {
    try {
      const traceIds = results.map(r => r.traceId);
      const exQuery = buildExceptionCheckQuery(traceIds, timeframe);
      const exToken = await executeQuery(config, exQuery);
      const exResult = await pollForResults(config, exToken);
      const exRecords = exResult.result?.records || [];
      const exMap = new Map(exRecords.map(r => [r['trace.id'], Number(r['exceptionCount']) || 0]));
      for (const r of results) {
        const count = exMap.get(r.traceId);
        if (count && count > 0) {
          r.hasExceptions = true;
          r.exceptionCount = count;
        }
      }
    } catch (err: unknown) {
      // Non-fatal: if the exception check fails, results still show
      // without exception badges rather than failing the whole search.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Exception check query failed:', msg);
    }
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────────────

export async function findTraceIdByRequestId(
  requestId: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<string | null> {
  if (process.env.USE_MOCK === 'true') {
    return loadMockResponse().result?.records?.[0]?.['trace.id'] as string || null;
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildRequestIdLookupQuery(requestId, timeframe);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  const records = result.result?.records || [];

  if (records.length === 0) return null;
  return (records[0]['trace.id'] as string) || null;
}

export async function fetchTraceById(
  traceId: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<DynatracePollResponse> {
  if (process.env.USE_MOCK === 'true') {
    return loadMockResponse();
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildDqlQuery(traceId, timeframe);
  const requestToken = await executeQuery(config, query);
  return await pollForResults(config, requestToken);
}

export async function searchTracesByUrl(
  url: string,
  environment: string,
  timeframe?: Timeframe,
  hostExact: boolean = false,
  userToken: string | null = null
): Promise<TraceMatch[]> {
  if (process.env.USE_MOCK === 'true') {
    return loadMockTraceMatches();
  }

  const { host, path: urlPath } = parseUrl(url);
  if (!host && !urlPath) {
    throw new Error('Invalid URL: could not parse hostname or path');
  }

  const config = getEnvConfig(environment, userToken);
  return runTraceMatchSearch(config, buildUrlSearchFilters(host, urlPath, hostExact), timeframe);
}

export async function searchTracesByClientIp(
  clientIp: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<TraceMatch[]> {
  const maskedIp = normalizeClientIp(clientIp);

  if (process.env.USE_MOCK === 'true') {
    return loadMockTraceMatches();
  }

  const config = getEnvConfig(environment, userToken);
  return runTraceMatchSearch(config, [buildClientIpFilter(maskedIp)], timeframe);
}

export async function searchUniqueUrls(
  url: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<EndpointMatch[]> {
  if (process.env.USE_MOCK === 'true') {
    return [];
  }

  const { host, path: urlPath } = parseUrl(url);
  if (!host && !urlPath) {
    throw new Error('Invalid URL: could not parse hostname or path');
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildEndpointSearchQuery(buildUrlSearchFilters(host, urlPath), timeframe);
  const requestToken = await executeQuery(config, query, { maxResultRecords: 10000, maxResultBytes: 10000000 });
  const result = await pollForResults(config, requestToken);
  const records = result.result?.records || [];

  // Normalize ID-like path segments and re-aggregate, so URL variants
  // that differ only by embedded IDs collapse into one logical endpoint.
  const grouped = new Map<string, EndpointMatch>();
  for (const r of records) {
    const method = (r['http.request.method'] as string) || '';
    const normalizedPath = normalizeUrlPath((r['url.path'] as string) || '');
    const service = (r['service'] as string) || '';
    const serverAddress = (r['serverAddress'] as string) || '';
    const count = Number(r['count']) || 0;
    const lastSeen = (r['lastSeen'] as string) || '';

    const key = `${method} ${normalizedPath}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += count;
      if (lastSeen > existing.lastSeen) existing.lastSeen = lastSeen;
      if (!existing.service) existing.service = service;
      if (!existing.serverAddress) existing.serverAddress = serverAddress;
    } else {
      grouped.set(key, { method, urlPath: normalizedPath, service, serverAddress, count, lastSeen });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => a.urlPath.localeCompare(b.urlPath) || a.method.localeCompare(b.method))
    .slice(0, 500);
}

export async function findLatestTraceIdForEndpoint(
  urlPath: string,
  method: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<string | null> {
  if (process.env.USE_MOCK === 'true') {
    return loadMockResponse().result?.records?.[0]?.['trace.id'] as string || null;
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildLatestTraceQuery(urlPath, method, timeframe);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  const records = result.result?.records || [];

  if (records.length === 0) return null;
  return (records[0]['trace.id'] as string) || null;
}

export async function fetchSessionEvents(
  sessionId: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<Record<string, unknown>[]> {
  if (process.env.USE_MOCK === 'true') {
    return [];
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildSessionQuery(sessionId, timeframe);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  return result.result?.records || [];
}
