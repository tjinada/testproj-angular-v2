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

  // OpenSearch index options. Format in .env:
  //   OPENSEARCH_INDEX_OPTIONS=CDBBOS|channels-olb-*,channels|channels-*
  // Each option is a `label|value` pair; pairs are comma-separated.
  // Falls back to a single default derived from OPENSEARCH_INDEX or 'channels-olb-*'.
  const openSearchIndices = parseIndexOptions(
    process.env.OPENSEARCH_INDEX_OPTIONS,
    process.env.OPENSEARCH_INDEX || 'channels-olb-*'
  );

  res.json({ envHostnamePatterns, environments, individualUserToken, tokenUrls, openSearchIndices });
});

function parseIndexOptions(raw: string | undefined, fallback: string): Array<{ label: string; value: string }> {
  if (!raw || raw.trim().length === 0) {
    return [{ label: fallback, value: fallback }];
  }
  // Format per entry: label|value  OR  label|value|timestampField
  // Pairs are comma-separated. The timestamp field (if present) is consumed
  // by the OpenSearch route, not the frontend, so we just ignore it here.
  const parsed = raw
    .split(',')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const parts = pair.split('|').map(s => s.trim());
      if (parts.length === 1) {
        return { label: parts[0], value: parts[0] };
      }
      return { label: parts[0], value: parts[1] };
    })
    .filter(opt => opt.label && opt.value);

  return parsed.length > 0 ? parsed : [{ label: fallback, value: fallback }];
}

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
  const sessionId = req.params.sessionId as string;
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
  const traceId = req.params.traceId as string;
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
