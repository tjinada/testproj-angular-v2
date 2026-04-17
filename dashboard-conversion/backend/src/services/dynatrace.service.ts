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
  duration: number;
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

// ── Proxy setup (matches ArtifactoryService pattern) ─────────────────
// Only activated when PROXY_TARGET is set. When running locally without
// a proxy, these env vars are empty and axios calls go direct.

const proxyAgent: HttpsProxyAgent<string> | null = (() => {
  const target = config.proxy?.target;
  if (!target) {
    console.log('[Dynatrace] No proxy target configured — connecting directly');
    return null;
  }
  const username = config.proxy.username || '';
  const password = config.proxy.password || '';
  const proxyUrl = `http://${username}:${password}@${target}`;
  console.log(`[Dynatrace] Using proxy: ${target} (user: ${username || '(none)'})`);
  console.log(`[Dynatrace] Proxy URL (redacted password): http://${username}:***@${target}`);
  return new HttpsProxyAgent(proxyUrl);
})();

if (proxyAgent) {
  console.log(`[Dynatrace] Proxy agent created successfully: ${typeof proxyAgent}`);
  console.log(`[Dynatrace] Proxy agent proxy URI: ${(proxyAgent as any).proxy?.href || 'N/A'}`);
} else {
  console.log(`[Dynatrace] No proxy agent — direct connections`);
}

/** Axios instance for Dynatrace API calls. Uses the corporate proxy when configured.
 * NOTE: The proxy must allow Basic auth for the Dynatrace domain.
 * If the proxy requires NTLM for this domain, a whitelist request to
 * the network team is needed (same as was done for Artifactory).
 */
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
 * fragment. This lets users paste URL paths without a leading slash
 * (e.g. "banking/services/signin") without accidentally being parsed
 * as host="banking", path="/services/signin".
 *
 * Returns an object with { host, path }. Either field may be an empty
 * string if not present in the input.
 */
function parseUrl(url: string): { host: string; path: string } {
  if (!url || typeof url !== 'string') return { host: '', path: '' };

  const trimmed = url.trim();
  const hadScheme = /^https?:\/\//i.test(trimmed);
  const remainder = trimmed.replace(/^https?:\/\//i, '');

  const firstSlash = remainder.indexOf('/');
  const firstSegment = firstSlash === -1 ? remainder : remainder.substring(0, firstSlash);

  // If no scheme and the first segment has no dot, treat the whole input
  // as a path fragment. Real hostnames in our environments always contain
  // dots; bare words like "banking" or "verifyCredential" are paths.
  if (!hadScheme && !firstSegment.includes('.')) {
    return { host: '', path: remainder };
  }

  // Otherwise split on the first slash into host + path. Collapse duplicate
  // slashes between host and path (e.g. "host//path" -> "host/path").
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

function buildUrlSearchQuery(host: string, urlPath: string, timeframe?: Timeframe, hostExact: boolean = false): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

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

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    ...filters,
    `| fieldsAdd _kindRank = if(span.kind == "server", 0, else: 1)`,
    `| sort _kindRank asc`,
    `| summarize {`,
    `    startTime = takeMin(start_time),`,
    `    endpoint = takeFirst(endpoint.name),`,
    `    service = takeFirst(dt.service.name),`,
    `    serverAddress = takeFirst(server.address),`,
    `    httpStatus = takeFirst(http.response.status_code),`,
    `    isFailed = countIf(request.is_failed == true) > 0,`,
    `    hasExceptions = countIf(isNotNull(span.events) and arraySize(span.events) > 0) > 0,`,
    `    duration = takeFirst(duration)`,
    `  }, by: { trace.id }`,
    `| sort startTime desc`,
    `| limit 100`
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

function buildDqlQuery(traceId: string, timeframe?: Timeframe): string {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const parts = [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 5000`,
    `| filter in(trace.id, {toUid("${traceId}")})`,
    `| limit 1000`,
    `// construct fields`,
    `| fieldsAdd span.source = if((isNotNull(dt.agent.module.id)) or matchesValue(telemetry.exporter.name, "odin") or matchesValue(telemetry.sdk.name, "oneagent") or matchesValue(dt.openpipeline.source, "oneagent"), "OneAgent", else: "OpenTelemetry")`,
    `// construct fields`,
    `| fieldsAdd icon = entityAttr(dt.entity.service, "icon")`,
    `// add entity lookups`,
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

async function executeQuery(config: ResolvedEnvConfig, query: string): Promise<string> {
  const executeUrl = `${config.url}/query:execute`;
  console.log(`[Dynatrace] POST ${executeUrl}`);
  console.log(`[Dynatrace] Query (first 200 chars): ${query.substring(0, 200)}...`);

  try {
    // Log full request details for proxy debugging
    const requestConfig = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token.substring(0, 10)}...`
      }
    };
    console.log(`[Dynatrace] executeQuery request details:`);
    console.log(`[Dynatrace]   URL: ${executeUrl}`);
    console.log(`[Dynatrace]   Proxy agent active: ${!!proxyAgent}`);
    console.log(`[Dynatrace]   httpClient defaults httpsAgent: ${!!httpClient.defaults.httpsAgent}`);
    console.log(`[Dynatrace]   httpClient defaults proxy: ${httpClient.defaults.proxy}`);

    const response = await httpClient.post<DynatraceExecuteResponse>(
    executeUrl,
    {
      query,
      defaultTimeframeStart: null,
      defaultTimeframeEnd: null
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

  console.log(`[Dynatrace] Execute succeeded — requestToken: ${response.data.requestToken.substring(0, 15)}...`);
  return response.data.requestToken;
  } catch (error: any) {
    const status = error.response?.status;
    const body = error.response?.data;
    const headers = error.response?.headers;
    console.error(`[Dynatrace] Execute failed — HTTP ${status || 'N/A'}`);
    if (headers) {
      console.error(`[Dynatrace] Response headers: ${JSON.stringify(headers)}`);
    }
    if (typeof body === 'string' && body.includes('<HTML')) {
      console.error('[Dynatrace] Response is HTML (likely proxy/gateway block)');
      console.error(`[Dynatrace] HTML body (first 300 chars): ${body.substring(0, 300)}`);
    } else if (body) {
      console.error(`[Dynatrace] Response body: ${JSON.stringify(body).substring(0, 500)}`);
    }
    if (error.code) {
      console.error(`[Dynatrace] Error code: ${error.code}`);
    }
    throw error;
  }
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

// ── Public API ───────────────────────────────────────────────────────

export async function findTraceIdByRequestId(
  requestId: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<string | null> {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning mock trace ID for request ID: ${requestId}`);
    const mock = loadMockResponse();
    const firstRecord = mock.result?.records?.[0];
    return (firstRecord?.['trace.id'] as string) || null;
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildRequestIdLookupQuery(requestId, timeframe);

  console.log(`[Dynatrace] Looking up trace ID for request ID: ${requestId} in ${environment}`);
  const requestToken = await executeQuery(config, query);

  console.log(`[Dynatrace] Polling for lookup results (token: ${requestToken.substring(0, 10)}...)`);
  const result = await pollForResults(config, requestToken);

  const records = result.result?.records || [];
  console.log(`[Dynatrace] Lookup returned ${records.length} record(s)`);

  if (records.length === 0) {
    return null;
  }

  return (records[0]['trace.id'] as string) || null;
}

export async function fetchTraceById(
  traceId: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<DynatracePollResponse> {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning mock response for trace: ${traceId}`);
    return loadMockResponse();
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildDqlQuery(traceId, timeframe);

  console.log(`[Dynatrace] Executing query for trace: ${traceId} in ${environment}`);
  const requestToken = await executeQuery(config, query);

  console.log(`[Dynatrace] Polling for results (token: ${requestToken.substring(0, 10)}...)`);
  const result = await pollForResults(config, requestToken);

  console.log(`[Dynatrace] Received ${result.result?.records?.length || 0} span records`);
  return result;
}

export async function searchTracesByUrl(
  url: string,
  environment: string,
  timeframe?: Timeframe,
  hostExact: boolean = false,
  userToken: string | null = null
): Promise<TraceMatch[]> {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning mock URL search results for: ${url}`);
    const mock = loadMockResponse();
    const records = mock.result?.records || [];
    const first = records[0];
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
      duration: Number(first['duration']) || 0
    }];
  }

  const { host, path: urlPath } = parseUrl(url);
  if (!host && !urlPath) {
    throw new Error('Invalid URL: could not parse hostname or path');
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildUrlSearchQuery(host, urlPath, timeframe, hostExact);

  console.log(`[Dynatrace] Searching traces by URL (host="${host}" hostExact=${hostExact}, path="${urlPath}") in ${environment}`);
  const requestToken = await executeQuery(config, query);

  console.log(`[Dynatrace] Polling for URL search results (token: ${requestToken.substring(0, 10)}...)`);
  const result = await pollForResults(config, requestToken);

  const records = result.result?.records || [];
  console.log(`[Dynatrace] URL search returned ${records.length} unique trace(s)`);

  return records.map(r => ({
    traceId: (r['trace.id'] as string) || '',
    startTime: (r['startTime'] as string) || '',
    endpoint: (r['endpoint'] as string) || '',
    service: (r['service'] as string) || '',
    serverAddress: (r['serverAddress'] as string) || '',
    httpStatus: String(r['httpStatus'] || ''),
    isFailed: r['isFailed'] === true,
    hasExceptions: r['hasExceptions'] === true,
    duration: Number(r['duration']) || 0
  }));
}

export async function fetchSessionEvents(
  sessionId: string,
  environment: string,
  timeframe?: Timeframe,
  userToken: string | null = null
): Promise<Record<string, unknown>[]> {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning empty mock session events for: ${sessionId}`);
    return [];
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildSessionQuery(sessionId, timeframe);

  console.log(`[Dynatrace] Fetching session events for session: ${sessionId} in ${environment}`);
  const requestToken = await executeQuery(config, query);

  console.log(`[Dynatrace] Polling for session events (token: ${requestToken.substring(0, 10)}...)`);
  const result = await pollForResults(config, requestToken);

  const records = result.result?.records || [];
  console.log(`[Dynatrace] Session query returned ${records.length} event(s)`);

  return records;
}
