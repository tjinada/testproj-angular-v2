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

module.exports = { fetchTraceById };
