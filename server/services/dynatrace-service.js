const axios = require('axios');

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

/**
 * Builds the full DQL query for fetching spans by trace ID.
 */
function buildDqlQuery(traceId, timeframe) {
  const timeframeClause = timeframe && timeframe.from && timeframe.to
    ? `timeframe: "${timeframe.from}/${timeframe.to}"`
    : 'from: -120m';

  return `fetch spans, ${timeframeClause}, scanLimitGBytes: 5000
| filter in(trace.id, {toUid("${traceId}")})
| construct fields
| fieldsAdd span.source = if((isNotNull(dt.agent.module.id)) or matchesValue(telemetry.exporter.name, "odin") or matchesValue(telemetry.sdk.name, "oneagent") or matchesValue(dt.openpipeline.source, "oneagent"), "OneAgent", else: "OpenTelemetry")
| fieldsAdd icon = entityAttr(dt.entity.service, "icon")
| fieldsAdd dt.entity.service.entity.name = entityAttr(dt.entity.service, "entity.name")
| fieldsAdd dt.entity.host.entity.name = entityAttr(dt.entity.host, "entity.name")
| fieldsAdd dt.entity.process_group.entity.name = entityAttr(dt.entity.process_group, "entity.name")
| fieldsAdd dt.entity.process_group_instance.entity.name = entityAttr(dt.entity.process_group_instance, "entity.name")`;
}

/**
 * Returns the Dynatrace config for the given environment.
 */
function getEnvConfig(environment = 'NON-PROD') {
  const config = ENV_CONFIG[environment.toUpperCase()];
  if (!config || !config.url || !config.token) {
    throw new Error(`Invalid or missing Dynatrace configuration for environment: ${environment}`);
  }
  return config;
}

/**
 * Step 1: Execute the DQL query. Returns a requestToken.
 */
async function executeQuery(config, query) {
  const response = await axios.post(
    `${config.url}/query:execute`,
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
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const response = await axios.get(
      `${config.url}/query:poll`,
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
 * Fetches trace data by trace ID using the 2-step execute + poll pattern.
 */
async function fetchTraceById(traceId, environment, timeframe) {
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
