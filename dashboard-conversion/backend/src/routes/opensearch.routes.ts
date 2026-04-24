import { Router, Request, Response } from 'express';
import { searchOpenSearch } from '../services/opensearch.service';

const router = Router();

// Accepted time-range presets (milliseconds). Anything outside this list is
// rejected — we do NOT want users to be able to request arbitrary ranges
// that could pull huge amounts of data or stress OpenSearch.
const ALLOWED_TIME_RANGES_MS = new Set<number>([
  60 * 60 * 1000,       // 1 hour
  4 * 60 * 60 * 1000,   // 4 hours
  24 * 60 * 60 * 1000   // 24 hours
]);

/**
 * POST /api/opensearch/search
 * Body: { searchTerm: string, timeRangeMs?: number }
 * Returns: { raw: unknown, status: number, elapsedMs: number, url: string }
 */
router.post('/search', async (req: Request, res: Response) => {
  const { searchTerm, timeRangeMs } = req.body || {};
  console.log(`[OpenSearch/route] POST /api/opensearch/search — term="${searchTerm}", timeRangeMs=${timeRangeMs}`);

  if (!searchTerm || typeof searchTerm !== 'string') {
    return res.status(400).json({ error: 'searchTerm is required' });
  }

  // Validate time range if provided; otherwise the service's default kicks in.
  let validatedRange: number | undefined;
  if (timeRangeMs !== undefined) {
    if (typeof timeRangeMs !== 'number' || !ALLOWED_TIME_RANGES_MS.has(timeRangeMs)) {
      return res.status(400).json({ error: 'Invalid timeRangeMs (must be 1h, 4h, or 24h)' });
    }
    validatedRange = timeRangeMs;
  }

  try {
    const result = await searchOpenSearch(searchTerm, validatedRange);
    res.json(result);
  } catch (error: any) {
    console.error(`[OpenSearch] Error for term="${searchTerm}":`, error.message);
    res.status(500).json({ error: error.message || 'Failed to search OpenSearch' });
  }
});

export default router;
