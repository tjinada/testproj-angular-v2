import { Router, Request, Response } from 'express';
import { searchOpenSearch } from '../services/opensearch.service';

const router = Router();

/**
 * POST /api/opensearch/search
 * Body: { searchTerm: string }
 * Returns: { raw: unknown, status: number, elapsedMs: number, url: string }
 */
router.post('/search', async (req: Request, res: Response) => {
  const { searchTerm } = req.body || {};
  console.log(`[OpenSearch/route] POST /api/opensearch/search — term="${searchTerm}"`);

  if (!searchTerm || typeof searchTerm !== 'string') {
    return res.status(400).json({ error: 'searchTerm is required' });
  }

  try {
    const result = await searchOpenSearch(searchTerm);
    res.json(result);
  } catch (error: any) {
    console.error(`[OpenSearch] Error for term="${searchTerm}":`, error.message);
    res.status(500).json({ error: error.message || 'Failed to search OpenSearch' });
  }
});

export default router;
