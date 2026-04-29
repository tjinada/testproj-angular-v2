import { Router, Request, Response } from 'express';
import { searchOpenSearch } from '../services/opensearch.service';

const router = Router();

// Server-side hard cap on the search window. Anything wider is rejected to
// prevent runaway queries / timeouts. Matches the largest UI option.
const MAX_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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
 * Body: { searchTerm: string, from: string, to: string, index?: string }
 *   - from / to are ISO 8601 timestamps
 *   - the [from, to] window must be ≤ 1 hour and `to` must not be in the future
 * Returns: { raw: unknown, status: number, elapsedMs: number, url: string }
 */
router.post('/search', async (req: Request, res: Response) => {
  const { searchTerm, from, to, index } = req.body || {};
  console.log(`[OpenSearch/route] POST /api/opensearch/search — term="${searchTerm}", from="${from}", to="${to}", index="${index}"`);

  if (!searchTerm || typeof searchTerm !== 'string') {
    return res.status(400).json({ error: 'searchTerm is required' });
  }

  // Validate from/to.
  if (typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'from and to are required (ISO 8601 strings)' });
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (isNaN(fromMs) || isNaN(toMs)) {
    return res.status(400).json({ error: 'Invalid from/to (must be ISO 8601 timestamps)' });
  }
  if (toMs <= fromMs) {
    return res.status(400).json({ error: 'to must be after from' });
  }
  if (toMs - fromMs > MAX_WINDOW_MS) {
    return res.status(400).json({ error: 'Search window must be 1 hour or less' });
  }
  // Allow a 60s grace for `to` slightly in the future (clock skew between
  // browser and server is common). Anything beyond that is rejected.
  if (toMs > Date.now() + 60_000) {
    return res.status(400).json({ error: 'to cannot be in the future' });
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
    const result = await searchOpenSearch(searchTerm, from, to, validatedIndex, timestampField);
    res.json(result);
  } catch (error: any) {
    console.error(`[OpenSearch] Error for term="${searchTerm}":`, error.message);
    res.status(500).json({ error: error.message || 'Failed to search OpenSearch' });
  }
});

export default router;
