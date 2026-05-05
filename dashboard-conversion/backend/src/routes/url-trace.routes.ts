import { Router, Request, Response } from 'express';
import { traceUrl } from '../services/url-trace.service';

const router = Router();

/**
 * POST /api/url-trace/flow
 * Body: {
 *   url: string,
 *   headers?: Record<string, string>  // optional; forwarded on every hop
 * }
 *
 * Returns the redirect chain and final URL for the given input URL.
 * Endpoint name `/flow` matches the convention used by the Akamai route
 * this feature replaces — same client-facing shape, simpler implementation.
 */
router.post('/flow', async (req: Request, res: Response) => {
  const body = (req.body || {}) as { url?: unknown; headers?: unknown };
  const url = typeof body.url === 'string' ? body.url : undefined;

  console.log(
    `[UrlTrace/route] POST /api/url-trace/flow ` +
    `(url=${url ? '"' + url + '"' : 'missing'}, ` +
    `headerCount=${body.headers && typeof body.headers === 'object' ? Object.keys(body.headers as object).length : 0})`
  );

  if (!url || url.trim() === '') {
    return res.status(400).json({ error: 'Request body must include url (full URL with scheme + host)' });
  }

  const trimmed = url.trim();

  // Validate URL format up front so we fail fast with a clear message.
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'URL must use http or https protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Validate optional headers payload. Allow only string→string entries.
  const headers: Record<string, string> = {};
  if (body.headers !== undefined && body.headers !== null) {
    if (typeof body.headers !== 'object' || Array.isArray(body.headers)) {
      return res.status(400).json({ error: 'headers must be an object of string key/value pairs' });
    }
    for (const [name, value] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof name !== 'string' || name.trim() === '') continue;
      if (typeof value !== 'string') {
        return res.status(400).json({ error: `Header "${name}" must have a string value` });
      }
      headers[name.trim()] = value;
    }
  }

  try {
    const result = await traceUrl(trimmed, headers);
    return res.json(result);
  } catch (error: any) {
    // Defensive: traceUrl is expected to handle its own errors and return
    // them in the result body, but catch anything unexpected here.
    console.error(`[UrlTrace/route] /flow failed: ${error.message}`);
    return res.status(500).json({ error: error.message || 'Internal error tracing URL' });
  }
});

export default router;
