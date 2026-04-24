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

function getAllowedIndices(): Set<string> {
  const raw = process.env.OPENSEARCH_INDEX_OPTIONS || '';
  const fallback = process.env.OPENSEARCH_INDEX || 'channels-olb-*';
  const out = new Set<string>();
  if (!raw.trim()) {
    out.add(fallback);
    return out;
  }
  for (const pair of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf('|');
    const value = idx === -1 ? pair : pair.slice(idx + 1).trim();
    if (value) out.add(value);
  }
  if (out.size === 0) out.add(fallback);
  return out;
}

/**
 * POST /api/opensearch/search
 * Body: { searchTerm: string, timeRangeMs?: number, index?: string }
 * Returns: { raw: unknown, status: number, elapsedMs: number, url: string }
 */
router.post('/search', async (req: Request, res: Response) => {
  const { searchTerm, timeRangeMs, index } = req.body || {};
  console.log(`[OpenSearch/route] POST /api/opensearch/search — term="${searchTerm}", timeRangeMs=${timeRangeMs}, index="${index}"`);

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

  // Validate index against the allow-list from .env.
  let validatedIndex: string | undefined;
  if (index !== undefined) {
    if (typeof index !== 'string' || !getAllowedIndices().has(index)) {
      return res.status(400).json({ error: 'Invalid index (must be one of the configured OPENSEARCH_INDEX_OPTIONS)' });
    }
    validatedIndex = index;
  }

  try {
    const result = await searchOpenSearch(searchTerm, validatedRange, validatedIndex);
    res.json(result);
  } catch (error: any) {
    console.error(`[OpenSearch] Error for term="${searchTerm}":`, error.message);
    res.status(500).json({ error: error.message || 'Failed to search OpenSearch' });
  }
});

export default router;
