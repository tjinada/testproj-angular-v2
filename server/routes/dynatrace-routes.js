const express = require('express');
const router = express.Router();
const dynatraceService = require('../services/dynatrace-service');

/**
 * POST /api/traces/lookup-by-request-id
 * Resolves a request ID to a trace ID via Dynatrace span lookup.
 */
router.post('/lookup-by-request-id', async (req, res) => {
  const { requestId, environment = 'NON-PROD', timeframe } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  try {
    const traceId = await dynatraceService.findTraceIdByRequestId(requestId, environment, timeframe);

    if (!traceId) {
      return res.status(404).json({ error: 'No trace found for that request ID in the selected time window' });
    }

    res.json({ traceId, requestId });
  } catch (error) {
    console.error(`[Dynatrace] Error looking up request ID ${requestId}:`, error.message);

    if (error.response?.data) {
      console.error('[Dynatrace] Response body:', JSON.stringify(error.response.data, null, 2));
    }

    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;

    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/traces/search-by-url
 * Searches for traces matching a full URL (hostname + path). Returns a
 * deduplicated list of trace matches sorted by most recent first.
 */
router.post('/search-by-url', async (req, res) => {
  const { url, environment = 'NON-PROD', timeframe } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const results = await dynatraceService.searchTracesByUrl(url, environment, timeframe);
    res.json({ results });
  } catch (error) {
    console.error(`[Dynatrace] Error searching by URL ${url}:`, error.message);

    if (error.response?.data) {
      console.error('[Dynatrace] Response body:', JSON.stringify(error.response.data, null, 2));
    }

    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;

    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/traces/:traceId
 * Fetches trace spans from Dynatrace for a given trace ID.
 */
router.post('/:traceId', async (req, res) => {
  const { traceId } = req.params;
  const { environment = 'NON-PROD', timeframe } = req.body;

  if (!traceId) {
    return res.status(400).json({ error: 'Trace ID is required' });
  }

  try {
    const result = await dynatraceService.fetchTraceById(traceId, environment, timeframe);
    res.json(result);
  } catch (error) {
    console.error(`[Dynatrace] Error fetching trace ${traceId}:`, error.message);

    // Log the full Dynatrace error response for debugging
    if (error.response?.data) {
      console.error('[Dynatrace] Response body:', JSON.stringify(error.response.data, null, 2));
    }

    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;

    res.status(status).json({ error: message });
  }
});

module.exports = router;
