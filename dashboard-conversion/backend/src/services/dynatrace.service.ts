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

interface ComponentSpanSearchResult {
  records: Record<string, unknown>[];
  tracesAnalyzed: number;
  tracesRequested: number;
}

interface CallerMatch {
  name: string;
  host: string;
  traceCount: number;
  lastSeen: string;
  exampleTraceId: string;
}

interface CallerSearchResult {
  callers: CallerMatch[];
  tracesAnalyzed: number;
  tracesRequested: number;
  tracesWithRoot: number;
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

const DEFAULT_COMPONENT_SEARCH_MAX_TRACES = 20;

function getComponentSearchMaxTraces(): number {
  const raw = parseInt(process.env.COMPONENT_SEARCH_MAX_TRACES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPONENT_SEARCH_MAX_TRACES;
}

const DEFAULT_CALLER_SEARCH_MAX_TRACES = 100;

function getCallerSearchMaxTraces(): number {
  const raw = parseInt(process.env.CALLER_SEARCH_MAX_TRACES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CALLER_SEARCH_MAX_TRACES;
}

// ── Proxy setup ──────────────────────────────────────────────────────
// Only activated when PROXY_TARGET is configured. Uses Dynatrace-specific
// proxy credentials (DYNATRACE_PROXY_USERNAME / DYNATRACE_PROXY_PASSWORD)

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
 * form.
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
 * Filter on the CDB ClientIP request attribute.
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
    if (segment.length >= 10 && /\d/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment)) return true;
    const digitCount = (segment.match(/\d/g) || []).length;
    return digitCount >= 3;
  };

  return rawPath
    .split('/')
    .map(segment => (segment && looksLikeId(segment)) ? '{id}' : segment)
    .join('/');
}

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
    `| filter isNotNull(http.response.status_code)`,
    `| sort start_time desc`,
    `| fields trace.id`,
    `| limit 1`
  ].join('\n');
}

/**
 * Pass 1 of the components-by-URL search: samples the most recent trace
 * IDs where the EXACT url.path returned HTTP 200.
 */
function buildComponentTraceIdQuery(urlPath: string, maxTraces: number, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    `| filter url.path == "${urlPath}"`,
    `| filter toString(http.response.status_code) == "200"`,
    `| summarize { lastSeen = takeMax(start_time) }, by: { trace.id }`,
    `| sort lastSeen desc`,
    `| limit ${maxTraces}`
  ].join('\n');
}

/**
 * Pass 2 of the components-by-URL search: fetches ALL spans for the
 * sampled trace IDs, trimmed to exactly the fields buildFlowGraph()
 */
function buildComponentSpansQuery(traceIds: string[], timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const uidList = traceIds.map(id => `toUid("${id}")`).join(', ');

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 5000`,
    `| filter in(trace.id, {${uidList}})`,
    `| fields trace.id, span.id, span.parent_id, span.kind, span.name, start_time, endpoint.name, url.path, server.address, db.namespace, host.name, k8s.container.name, websphere.server.name, otel.scope.name, request.is_failed, dt.failure_detection.verdict, http.response.status_code, dt.entity.service, dt.service.name, dt.entity.host`,
    `| fieldsAdd dt.entity.service.entity.name = entityAttr(dt.entity.service, "entity.name")`,
    `| fieldsAdd dt.entity.host.entity.name = entityAttr(dt.entity.host, "entity.name")`,
    `| limit 20000`
  ].join('\n');
}

type CallerTargetKind = 'service' | 'external' | 'db';

/**
 * Pass 1 of the component-callers search: samples the most recent trace
 * IDs containing the component
 */
function buildCallerTraceIdQuery(component: string, kind: CallerTargetKind, maxTraces: number, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  let filterLines: string[];
  if (kind === 'external') {
    filterLines = [`| filter server.address == "${component}"`];
  } else if (kind === 'db') {
    filterLines = [`| filter db.namespace == "${component}"`];
  } else {
    filterLines = [
      `| fieldsAdd resolvedName = entityAttr(dt.entity.service, "entity.name")`,
      `| filter resolvedName == "${component}" or dt.service.name == "${component}"`
    ];
  }

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    ...filterLines,
    `| summarize { lastSeen = takeMax(start_time) }, by: { trace.id }`,
    `| sort lastSeen desc`,
    `| limit ${maxTraces}`
  ].join('\n');
}

/** Shared timeframe clause for caller pass-2 queries: 'from' widened by
 *  60 minutes so a trace sampled near the window's leading edge still
 *  includes its true entry span; the trace-ID filter keeps results
 *  constrained. */
function widenedCallerTimeframeClause(timeframe?: Timeframe): string {
  if (timeframe && timeframe.from && timeframe.to) {
    const widenedFrom = new Date(new Date(timeframe.from).getTime() - 60 * 60 * 1000).toISOString();
    return `timeframe: "${widenedFrom}/${timeframe.to}"`;
  }
  return 'from: -180m';
}

/**
 * Pass 2a of the component-callers search: the entry TIMESTAMP of each
 * sampled trace via takeMin — a true order-independent aggregate. (An
 * earlier single-query variant used `sort | summarize takeFirst(...)`,
 * but Grail's distributed summarize does not honor the preceding sort
 * in this tenant, yielding arbitrary spans as "entry" and false
 * callers.) pairKey is built with DQL's own toString so pass 2b can
 * echo the exact strings back — immune to timestamp-format mismatches
 * between DQL and JSON serialization.
 */
function buildCallerEntryTimesQuery(traceIds: string[], timeframe?: Timeframe): string {
  const uidList = traceIds.map(id => `toUid("${id}")`).join(', ');

  return [
    `fetch spans, ${widenedCallerTimeframeClause(timeframe)}, scanLimitGBytes: 5000`,
    `| filter in(trace.id, {${uidList}})`,
    `| summarize { entryStart = takeMin(start_time) }, by: { trace.id }`,
    `| fieldsAdd pairKey = concat(toString(trace.id), "#", toString(entryStart))`
  ].join('\n');
}

/**
 * Pass 2b of the component-callers search: fetches exactly the entry
 * spans identified by pass 2a, matching on the (trace.id, start_time)
 * pairKey. Result is ~one record per trace — the provably earliest
 * span — with the fields needed to resolve the caller's name and host.
 */
function buildCallerEntrySpanFetchQuery(traceIds: string[], pairKeys: string[], timeframe?: Timeframe): string {
  const uidList = traceIds.map(id => `toUid("${id}")`).join(', ');
  const keyList = pairKeys.map(k => `"${k}"`).join(', ');

  return [
    `fetch spans, ${widenedCallerTimeframeClause(timeframe)}, scanLimitGBytes: 5000`,
    `| filter in(trace.id, {${uidList}})`,
    `| fieldsAdd pairKey = concat(toString(trace.id), "#", toString(start_time))`,
    `| filter in(pairKey, {${keyList}})`,
    `| fields trace.id, start_time, dt.service.name, dt.entity.service, k8s.container.name, websphere.server.name, host.name, dt.entity.host`,
    `| fieldsAdd dt.entity.service.entity.name = entityAttr(dt.entity.service, "entity.name")`,
    `| fieldsAdd dt.entity.host.entity.name = entityAttr(dt.entity.host, "entity.name")`
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

export async function searchComponentsByUrl(
  urlPath: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<ComponentSpanSearchResult> {
  const maxTraces = getComponentSearchMaxTraces();

  if (process.env.USE_MOCK === 'true') {
    const records = loadMockResponse().result?.records || [];
    return { records, tracesAnalyzed: records.length > 0 ? 1 : 0, tracesRequested: maxTraces };
  }

  const config = getEnvConfig(environment, userToken);

  const idQuery = buildComponentTraceIdQuery(urlPath.trim(), maxTraces, timeframe);
  const idToken = await executeQuery(config, idQuery);
  const idResult = await pollForResults(config, idToken);
  const traceIds = (idResult.result?.records || [])
    .map(r => (r['trace.id'] as string) || '')
    .filter(Boolean);

  if (traceIds.length === 0) {
    return { records: [], tracesAnalyzed: 0, tracesRequested: maxTraces };
  }

  const spanQuery = buildComponentSpansQuery(traceIds, timeframe);
  const spanToken = await executeQuery(config, spanQuery, { maxResultRecords: 20000, maxResultBytes: 52428800 });
  const spanResult = await pollForResults(config, spanToken);

  return {
    records: spanResult.result?.records || [],
    tracesAnalyzed: traceIds.length,
    tracesRequested: maxTraces
  };
}

export async function searchComponentCallers(
  component: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null,
  kind: CallerTargetKind = 'service'
): Promise<CallerSearchResult> {
  const maxTraces = getCallerSearchMaxTraces();

  if (process.env.USE_MOCK === 'true') {
    return { callers: [], tracesAnalyzed: 0, tracesRequested: maxTraces, tracesWithRoot: 0 };
  }

  const config = getEnvConfig(environment, userToken);

  const idQuery = buildCallerTraceIdQuery(component.trim(), kind, maxTraces, timeframe);
  const idToken = await executeQuery(config, idQuery);
  const idResult = await pollForResults(config, idToken);
  const traceIds = (idResult.result?.records || [])
    .map(r => (r['trace.id'] as string) || '')
    .filter(Boolean);

  if (traceIds.length === 0) {
    return { callers: [], tracesAnalyzed: 0, tracesRequested: maxTraces, tracesWithRoot: 0 };
  }

  // Pass 2a: entry timestamp per trace (takeMin — order-independent).
  const entryTimesQuery = buildCallerEntryTimesQuery(traceIds, timeframe);
  const entryTimesToken = await executeQuery(config, entryTimesQuery, { maxResultRecords: 50000, maxResultBytes: 52428800 });
  const entryTimesResult = await pollForResults(config, entryTimesToken);
  const pairKeys = (entryTimesResult.result?.records || [])
    .map(r => (r['pairKey'] as string) || '')
    .filter(Boolean);

  if (pairKeys.length === 0) {
    return { callers: [], tracesAnalyzed: traceIds.length, tracesRequested: maxTraces, tracesWithRoot: 0 };
  }

  // Pass 2b: fetch exactly those entry spans by echoing the pairKeys back.
  const entrySpanQuery = buildCallerEntrySpanFetchQuery(traceIds, pairKeys, timeframe);
  const entrySpanToken = await executeQuery(config, entrySpanQuery, { maxResultRecords: 50000, maxResultBytes: 52428800 });
  const entrySpanResult = await pollForResults(config, entrySpanToken);
  const entrySpans = entrySpanResult.result?.records || [];

  // Dedupe entry spans by (caller name, host). seenTraces guards the
  // rare same-timestamp tie (two spans matching one trace's pairKey):
  // first record per trace wins.
  const grouped = new Map<string, { match: CallerMatch; traceIds: Set<string> }>();
  const tracesWithRoot = new Set<string>();
  const seenTraces = new Set<string>();

  for (const r of entrySpans) {
    const traceId = (r['trace.id'] as string) || '';
    if (!traceId || seenTraces.has(traceId)) continue;
    seenTraces.add(traceId);
    tracesWithRoot.add(traceId);

    const name =
      (r['dt.entity.service.entity.name'] as string) ||
      (r['dt.service.name'] as string) ||
      (r['dt.entity.service'] as string) ||
      'Unknown';
    const host =
      (r['websphere.server.name'] as string) ||
      (r['k8s.container.name'] as string) ||
      (r['host.name'] as string) ||
      (r['dt.entity.host.entity.name'] as string) ||
      '';
    const startTime = (r['start_time'] as string) || '';

    const key = `${name}||${host}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.traceIds.add(traceId);
      if (startTime > existing.match.lastSeen) {
        existing.match.lastSeen = startTime;
        existing.match.exampleTraceId = traceId;
      }
    } else {
      grouped.set(key, {
        match: { name, host, traceCount: 0, lastSeen: startTime, exampleTraceId: traceId },
        traceIds: new Set([traceId])
      });
    }
  }

  const callers = Array.from(grouped.values())
    .map(g => ({ ...g.match, traceCount: g.traceIds.size }))
    .sort((a, b) => b.traceCount - a.traceCount || a.name.localeCompare(b.name));

  return {
    callers,
    tracesAnalyzed: traceIds.length,
    tracesRequested: maxTraces,
    tracesWithRoot: tracesWithRoot.size
  };
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