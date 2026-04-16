import { Router, Request, Response } from 'express';
import {
  fetchTraceById,
  findTraceIdByRequestId,
  searchTracesByUrl,
  fetchSessionEvents
} from '../services/dynatrace.service';

const router = Router();

// ── Config endpoint ──────────────────────────────────────────────────

/**
 * GET /api/error-analyzer/config
 * Exposes frontend-relevant configuration values sourced from .env.
 */
router.get('/config', (_req: Request, res: Response) => {
  const patternsRaw = process.env.ENV_HOSTNAME_PATTERNS || '';
  const envHostnamePatterns = patternsRaw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const environments = [
    { id: 'NON-PROD', label: 'Non-Prod', isProd: false }
  ];

  if (process.env.DYNATRACE_PROD_ENABLED === 'true') {
    environments.push({ id: 'PROD', label: 'Prod', isProd: true });
  }

  const individualUserToken = process.env.INDIVIDUAL_USER_TOKEN === 'true';

  const tokenUrls: Record<string, string> = {};
  if (individualUserToken) {
    if (process.env.DYNATRACE_NONPROD_TOKEN_URL) {
      tokenUrls['NON-PROD'] = process.env.DYNATRACE_NONPROD_TOKEN_URL;
    }
    if (process.env.DYNATRACE_PROD_TOKEN_URL) {
      tokenUrls['PROD'] = process.env.DYNATRACE_PROD_TOKEN_URL;
    }
  }

  res.json({ envHostnamePatterns, environments, individualUserToken, tokenUrls });
});

// ── Trace endpoints ──────────────────────────────────────────────────

/**
 * POST /api/error-analyzer/traces/lookup-by-request-id
 */
router.post('/traces/lookup-by-request-id', async (req: Request, res: Response) => {
  const { requestId, environment = 'NON-PROD', timeframe, userToken } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  try {
    const traceId = await findTraceIdByRequestId(requestId, environment, timeframe, userToken);

    if (!traceId) {
      return res.status(404).json({ error: 'No trace found for that request ID in the selected time window' });
    }

    res.json({ traceId, requestId });
  } catch (error: any) {
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
 * POST /api/error-analyzer/traces/search-by-url
 */
router.post('/traces/search-by-url', async (req: Request, res: Response) => {
  const { url, environment = 'NON-PROD', timeframe, hostExact = false, userToken } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const results = await searchTracesByUrl(url, environment, timeframe, hostExact, userToken);
    res.json({ results });
  } catch (error: any) {
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
 * POST /api/error-analyzer/traces/session/:sessionId
 */
router.post('/traces/session/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { environment = 'NON-PROD', timeframe, userToken } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }

  try {
    const events = await fetchSessionEvents(sessionId, environment, timeframe, userToken);
    res.json({ events });
  } catch (error: any) {
    console.error(`[Dynatrace] Error fetching session ${sessionId}:`, error.message);
    if (error.response?.data) {
      console.error('[Dynatrace] Response body:', JSON.stringify(error.response.data, null, 2));
    }
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;
    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/error-analyzer/traces/:traceId
 */
router.post('/traces/:traceId', async (req: Request, res: Response) => {
  const { traceId } = req.params;
  const { environment = 'NON-PROD', timeframe, userToken } = req.body;

  if (!traceId) {
    return res.status(400).json({ error: 'Trace ID is required' });
  }

  try {
    const result = await fetchTraceById(traceId, environment, timeframe, userToken);
    res.json(result);
  } catch (error: any) {
    console.error(`[Dynatrace] Error fetching trace ${traceId}:`, error.message);
    if (error.response?.data) {
      console.error('[Dynatrace] Response body:', JSON.stringify(error.response.data, null, 2));
    }
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;
    res.status(status).json({ error: message });
  }
});

export default router;
