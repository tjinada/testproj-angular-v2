const express = require('express');
const router = express.Router();
const dynatraceService = require('../services/dynatrace-service');

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

    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;

    res.status(status).json({ error: message });
  }
});

module.exports = router;
