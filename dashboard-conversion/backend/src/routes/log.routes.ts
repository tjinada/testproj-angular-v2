import { Router, Request, Response } from 'express';
import { searchLog } from '../services/log.service';

const router = Router();

/**
 * POST /api/logs/search
 * Body: { logUrl: string, reqId: string }
 * Returns: { lines: string[], totalMatched: number, truncated: boolean }
 */
router.post('/search', async (req: Request, res: Response) => {
  const { logUrl, reqId } = req.body || {};

  if (!logUrl || typeof logUrl !== 'string') {
    return res.status(400).json({ error: 'logUrl is required' });
  }

  if (!reqId || typeof reqId !== 'string') {
    return res.status(400).json({ error: 'reqId is required' });
  }

  // Only allow http/https to avoid file:// or other unintended schemes.
  if (!/^https?:\/\//i.test(logUrl)) {
    return res.status(400).json({ error: 'logUrl must be http(s)' });
  }

  try {
    const result = await searchLog(logUrl, reqId);
    res.json(result);
  } catch (error: any) {
    console.error(`[Logs] Error searching log ${logUrl} for REQID=${reqId}:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to search log' });
  }
});

export default router;
