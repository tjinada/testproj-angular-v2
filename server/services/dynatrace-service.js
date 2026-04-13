const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
 * Parses a user-supplied URL into a hostname and path. Accepts inputs with
 * or without a scheme (e.g. "https://host/path", "host/path", "host//path").
 * Returns an object with { host, path }. Either field may be an empty string
 * if not present in the input.
 */
function parseUrl(url) {
  if (!url || typeof url !== 'string') return { host: '', path: '' };

  // Strip scheme if present
  let remainder = url.trim().replace(/^https?:\/\//i, '');

  // Split on the first single slash into host + path
  // Collapse duplicate slashes between host and path (e.g. "host//path" -> "host/path")
  const firstSlash = remainder.indexOf('/');
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
 * Uses contains() on both fields so partial pastes still match. Deduplicates
 * by trace.id via summarize, and returns the most recent 100 matches.
 */
function buildUrlSearchQuery(host, path, timeframe) {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  const filters = [`| filter span.kind == "server"`];
  if (path) {
    filters.push(`| filter contains(url.path, "${path}")`);
  }
  if (host) {
    filters.push(`| filter contains(server.address, "${host}")`);
  }

  return [
    `fetch spans, ${timeframeClause}, scanLimitGBytes: 500`,
    ...filters,
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
 */
function getEnvConfig(environment = 'NON-PROD') {
  const config = ENV_CONFIG[environment.toUpperCase()];
  if (!config || !config.url || !config.token) {
    throw new Error(`Invalid or missing Dynatrace configuration for environment: ${environment}`);
  }
  config.url = config.url.replace(/\/+$/, '');
  return config;
}

/**
 * Step 1: Execute the DQL query. Returns a requestToken.
 */
async function executeQuery(config, query) {
  const executeUrl = `${config.url}/query:execute`;
  console.log(`[Dynatrace] POST ${executeUrl}`);

  const response = await axios.post(
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
    const response = await axios.get(
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
async function findTraceIdByRequestId(requestId, environment, timeframe) {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning mock trace ID for request ID: ${requestId}`);
    const mock = loadMockResponse();
    const firstRecord = mock.result?.records?.[0];
    return firstRecord?.['trace.id'] || null;
  }

  const config = getEnvConfig(environment);
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

  return records[0]['trace.id'] || null;
}

/**
 * Fetches trace data by trace ID.
 * If USE_MOCK is enabled, returns the mock response.
 * Otherwise, performs the 2-step execute + poll pattern against Dynatrace.
 */
async function fetchTraceById(traceId, environment, timeframe) {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning mock response for trace: ${traceId}`);
    return loadMockResponse();
  }

  const config = getEnvConfig(environment);
  const query = buildDqlQuery(traceId, timeframe);

  console.log(`[Dynatrace] Executing query for trace: ${traceId} in ${environment}`);
  const requestToken = await executeQuery(config, query);

  console.log(`[Dynatrace] Polling for results (token: ${requestToken.substring(0, 10)}...)`);
  const result = await pollForResults(config, requestToken);

  console.log(`[Dynatrace] Received ${result.result?.records?.length || 0} span records`);
  return result;
}

/**
 * Searches for traces by full URL. Parses the URL into host + path and
 * queries Dynatrace spans. Returns a deduplicated list of matches sorted
 * by most recent first.
 */
async function searchTracesByUrl(url, environment, timeframe) {
  if (process.env.USE_MOCK === 'true') {
    console.log(`[Mock] Returning mock URL search results for: ${url}`);
    const mock = loadMockResponse();
    const records = mock.result?.records || [];
    // Derive a single synthetic match from the mock for UI testing
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
      duration: Number(first['duration']) || 0
    }];
  }

  const { host, path } = parseUrl(url);
  if (!host && !path) {
    throw new Error('Invalid URL: could not parse hostname or path');
  }

  const config = getEnvConfig(environment);
  const query = buildUrlSearchQuery(host, path, timeframe);

  console.log(`[Dynatrace] Searching traces by URL (host="${host}", path="${path}") in ${environment}`);
  const requestToken = await executeQuery(config, query);

  console.log(`[Dynatrace] Polling for URL search results (token: ${requestToken.substring(0, 10)}...)`);
  const result = await pollForResults(config, requestToken);

  const records = result.result?.records || [];
  console.log(`[Dynatrace] URL search returned ${records.length} unique trace(s)`);

  // Normalize field names from DQL output to the UrlSearchResult shape
  return records.map(r => ({
    traceId: r['trace.id'] || '',
    startTime: r['startTime'] || '',
    endpoint: r['endpoint'] || '',
    service: r['service'] || '',
    serverAddress: r['serverAddress'] || '',
    httpStatus: String(r['httpStatus'] || ''),
    isFailed: r['isFailed'] === true,
    duration: Number(r['duration']) || 0
  }));
}

module.exports = { fetchTraceById, findTraceIdByRequestId, searchTracesByUrl };
