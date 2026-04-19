const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Environment config mapping
const ENV_CONFIG = {
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

// Proxy setup — only activated when PROXY_TARGET is set. Uses
// DYNATRACE_PROXY_USERNAME/PASSWORD if set, otherwise falls back to
// shared PROXY_USERNAME/PASSWORD. This allows a different account for
// Dynatrace without affecting other services.
const proxyAgent = (() => {
  const target = process.env.PROXY_TARGET;
  if (!target) return null;

  const username = process.env.DYNATRACE_PROXY_USERNAME || process.env.PROXY_USERNAME || '';
  const password = process.env.DYNATRACE_PROXY_PASSWORD || process.env.PROXY_PASSWORD || '';
  const proxyUrl = `http://${username}:${password}@${target}`;
  return new HttpsProxyAgent(proxyUrl);
})();

/** Axios instance for Dynatrace API calls. Uses the corporate proxy when configured. */
const httpClient = axios.create({
  ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
});

/**
 * Builds the lookup DQL query for resolving a request ID to a trace ID.
 * Accepts an optional timeframe; falls back to the same default as the trace fetch query.
 */
function buildRequestIdLookupQuery(requestId, timeframe) {
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
function parseUrl(url) {
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
  let path = '';
  if (firstSlash === -1) {
    host = remainder;
  } else {
    host = remainder.substring(0, firstSlash);
    path = remainder.substring(firstSlash).replace(/^\/+/, '/');
  }

  return { host, path };
}

/**
 * Builds the DQL query for searching traces by URL (hostname + path).
 * Uses contains() on path so partial pastes still match. Host matching is
 * exact when hostExact is true (session flow) and contains() otherwise
 * (free-form search bar flow). Deduplicates by trace.id via summarize, and
 * returns the most recent 100 matches.
 *
 * Note: we deliberately do NOT filter by span.kind == "server". Pasting an
 * outbound URL (e.g. a downstream API the monitored service calls) should
 * still find the trace, even though that URL only appears on a client span.
 * To keep the summarized result row meaningful, we bias takeFirst() inside
 * summarize toward server spans via a synthetic _kindRank field so the
 * entry-point service still wins when one is present in the matches.
 */
function buildUrlSearchQuery(host, path, timeframe, hostExact = false) {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const filters = [];
  if (path) {
    filters.push(`| filter contains(lower(url.path), lower("${path}"))`);
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
    `    duration = takeFirst(duration)`,
    `  }, by: { trace.id }`,
    `| sort startTime desc`,
    `| limit 100`
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
function buildExceptionCheckQuery(traceIds, timeframe) {
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

/**
 * Builds the DQL query for fetching all user.events records for a session.
 */
function buildSessionQuery(sessionId, timeframe) {
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
 * Builds the full DQL query for fetching spans by trace ID.
 */
function buildDqlQuery(traceId, timeframe) {
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

/**
 * Returns the Dynatrace config for the given environment.
 *
 * When a userToken is provided (individual user token mode), it takes
 * priority over the .env token. The .env URL is still required — only
 * the token is user-supplied.
 */
function getEnvConfig(environment = 'NON-PROD', userToken = null) {
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
 * Step 1: Execute the DQL query. Returns a requestToken.
 */
async function executeQuery(config, query) {
  const executeUrl = `${config.url}/query:execute`;

  const response = await httpClient.post(
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

  return response.data.requestToken;
}

/**
 * Step 2: Poll for results until state is no longer RUNNING.
 */
async function pollForResults(config, requestToken) {
  const pollUrl = `${config.url}/query:poll`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const response = await httpClient.get(
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

/**
 * Loads the mock response from disk.
 */
function loadMockResponse() {
  if (!fs.existsSync(MOCK_FILE_PATH)) {
    throw new Error(`Mock file not found at: ${MOCK_FILE_PATH}`);
  }
  const content = fs.readFileSync(MOCK_FILE_PATH, 'utf8');
  return JSON.parse(content);
}

/**
 * Resolves a request ID to a trace ID by querying Dynatrace spans.
 * Returns the trace ID string, or null if no matching span was found.
 */
async function findTraceIdByRequestId(requestId, environment, timeframe, userToken = null) {
  if (process.env.USE_MOCK === 'true') {
    return loadMockResponse().result?.records?.[0]?.['trace.id'] || null;
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildRequestIdLookupQuery(requestId, timeframe);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  const records = result.result?.records || [];

  if (records.length === 0) return null;
  return records[0]['trace.id'] || null;
}

/**
 * Fetches trace data by trace ID.
 * If USE_MOCK is enabled, returns the mock response.
 * Otherwise, performs the 2-step execute + poll pattern against Dynatrace.
 */
async function fetchTraceById(traceId, environment, timeframe, userToken = null) {
  if (process.env.USE_MOCK === 'true') {
    return loadMockResponse();
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildDqlQuery(traceId, timeframe);
  const requestToken = await executeQuery(config, query);
  return await pollForResults(config, requestToken);
}

/**
 * Searches for traces by full URL. Parses the URL into host + path and
 * queries Dynatrace spans. Returns a deduplicated list of matches sorted
 * by most recent first. When hostExact is true, uses exact hostname match
 * so cross-environment pollution is avoided.
 */
async function searchTracesByUrl(url, environment, timeframe, hostExact = false, userToken = null) {
  if (process.env.USE_MOCK === 'true') {
    const mock = loadMockResponse();
    const records = mock.result?.records || [];
    const first = records[0];
    if (!first) return [];
    return [{
      traceId: first['trace.id'] || '',
      startTime: first['start_time'] || '',
      endpoint: first['endpoint.name'] || '',
      service: first['dt.service.name'] || '',
      serverAddress: first['server.address'] || '',
      httpStatus: String(first['http.response.status_code'] || ''),
      isFailed: first['request.is_failed'] === true,
      hasExceptions: false,
      exceptionCount: 0,
      duration: Number(first['duration']) || 0
    }];
  }

  const { host, path } = parseUrl(url);
  if (!host && !path) {
    throw new Error('Invalid URL: could not parse hostname or path');
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildUrlSearchQuery(host, path, timeframe, hostExact);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  const records = result.result?.records || [];

  // Normalize field names from DQL output
  const results = records.map(r => ({
    traceId: r['trace.id'] || '',
    startTime: r['startTime'] || '',
    endpoint: r['endpoint'] || '',
    service: r['service'] || '',
    serverAddress: r['serverAddress'] || '',
    httpStatus: String(r['httpStatus'] || ''),
    isFailed: r['isFailed'] === true,
    hasExceptions: false,
    exceptionCount: 0,
    duration: Number(r['duration']) || 0
  }));

  // Second-pass: check for exceptions across ALL spans in the matched
  // trace IDs. The URL search query only sees spans matching the URL
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
    } catch (err) {
      // Non-fatal: if the exception check fails, results still show
      // without exception badges rather than failing the whole search.
      console.warn('Exception check query failed:', err.message);
    }
  }

  return results;
}

/**
 * Fetches all user.events records for a given RUM session ID.
 * Uses the same execute + poll pattern as trace fetches.
 */
async function fetchSessionEvents(sessionId, environment, timeframe, userToken = null) {
  if (process.env.USE_MOCK === 'true') {
    return [];
  }

  const config = getEnvConfig(environment, userToken);
  const query = buildSessionQuery(sessionId, timeframe);
  const requestToken = await executeQuery(config, query);
  const result = await pollForResults(config, requestToken);
  return result.result?.records || [];
}

module.exports = { fetchTraceById, findTraceIdByRequestId, searchTracesByUrl, fetchSessionEvents };
