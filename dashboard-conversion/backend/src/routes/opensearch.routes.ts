import { Router, Request, Response } from 'express';
import { searchOpenSearch } from '../services/opensearch.service';

const router = Router();

// Accepted time-range presets (milliseconds). Anything outside this list is
// rejected — we do NOT want users to be able to request arbitrary ranges
// that could pull huge amounts of data or stress OpenSearch.
const ALLOWED_TIME_RANGES_MS = new Set<number>([
  15 * 60 * 1000,       // 15 minutes
  30 * 60 * 1000,       // 30 minutes
  60 * 60 * 1000,       // 1 hour
  2 * 60 * 60 * 1000,   // 2 hours
  6 * 60 * 60 * 1000,   // 6 hours
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
    const parts = pair.split('|').map(s => s.trim());
    // Format: label|value  OR  label|value|timestampField
    const value = parts.length >= 2 ? parts[1] : parts[0];
    if (value) out.add(value);
  }
  if (out.size === 0) out.add(fallback);
  return out;
}

/**
 * Resolve the timestamp field to use for a given index pattern, parsed from
 * OPENSEARCH_INDEX_OPTIONS (format: label|value|timestampField). Falls back
 * to '@timestamp' when no per-index field is configured.
 */
function getTimestampFieldForIndex(indexValue: string): string {
  const raw = process.env.OPENSEARCH_INDEX_OPTIONS || '';
  const DEFAULT_FIELD = '@timestamp';
  if (!raw.trim()) return DEFAULT_FIELD;
  for (const pair of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const parts = pair.split('|').map(s => s.trim());
    if (parts.length < 2) continue;
    const value = parts[1];
    const tsField = parts[2];
    if (value === indexValue && tsField) return tsField;
  }
  return DEFAULT_FIELD;
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
      return res.status(400).json({ error: 'Invalid timeRangeMs (must be 15m, 30m, 1h, 2h, 6h, or 24h)' });
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
    const timestampField = validatedIndex ? getTimestampFieldForIndex(validatedIndex) : '@timestamp';
    console.log(`[OpenSearch/route] resolved timestampField="${timestampField}" for index="${validatedIndex || '(default)'}"`);
    const result = await searchOpenSearch(searchTerm, validatedRange, validatedIndex, timestampField);
    res.json(result);
  } catch (error: any) {
    console.error(`[OpenSearch] Error for term="${searchTerm}":`, error.message);
    res.status(500).json({ error: error.message || 'Failed to search OpenSearch' });
  }
});

export default router;
