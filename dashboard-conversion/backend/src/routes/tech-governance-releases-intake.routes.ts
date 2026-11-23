import { Router, Request, Response } from 'express';
import techGovernanceReleasesIntakeService, {
  TechGovernanceRelease,
  TechGovernanceReleaseIntake,
} from '../services/tech-governance-releases-intake.service';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /api/tech-governance-releases-intake
 * Returns the cached tech governance releases intake data.
 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  try {
    const releases = Object.values(techGovernanceReleasesIntakeService.getAll());
    res.json(releases);
  } catch (error) {
    console.error('Error fetching tech governance releases:', error);
    res.status(500).json({ error: 'Failed to fetch tech governance releases' });
  }
});

/**
 * Shared handler for POST (create) and PUT (update). Validates the body,
 * fetches the latest intakes from Confluence, builds a filtered
 * TechGovernanceRelease, and delegates to the service.
 */
async function upsertRelease(
  req: Request,
  res: Response,
  mode: 'create' | 'update',
): Promise<Response | void> {
  try {
    const { branch, intakePageId } = req.body ?? {};

    if (!branch || typeof branch !== 'string') {
      return res.status(400).json({ error: 'Body field "branch" (string) is required' });
    }
    if (!intakePageId || typeof intakePageId !== 'string') {
      return res.status(400).json({ error: 'Body field "intakePageId" (string) is required' });
    }

    let intakes: TechGovernanceReleaseIntake[] = [];
    try {
      intakes = await techGovernanceReleasesIntakeService.fetchConfluenceChildPagesDetails(intakePageId);
      if (mode === 'update') {
        intakes = intakes.map((intake) => {
            const updatedIntake = req.body.intakes.find((i: TechGovernanceReleaseIntake) => i.id === intake.id);
            if (updatedIntake && updatedIntake.platformVeto) {
                return { ...intake, platformVeto: updatedIntake.platformVeto };
            }
            return intake;
        });
      }
    } catch (err) {
      intakes = [];
      console.error('Error refreshing Confluence intake data for tech governance release', {intakePageId, mode, error: err});
      return res.status(502).json({
         error: 'Failed to refresh intake data from Confluence',
       });
    }

    const filteredData: TechGovernanceRelease = {
      gracePeriodInDays: req.body.gracePeriodInDays || 0,
      details: req.body.details || '',
      intakePageId,
      branch,
      intakes,
    };

    if (mode === 'create') {
      const created = await techGovernanceReleasesIntakeService.add(branch, filteredData);
      return res.status(201).json({ message: 'Release created successfully', release: created });
    }

    const updated = await techGovernanceReleasesIntakeService.update(branch, filteredData);
    return res.json({ message: 'Release updated successfully', release: updated });
  } catch (error: any) {
    if (mode === 'create' && error?.message?.includes('already exists')) {
      return res.status(409).json({ error: error.message });
    }
    if (mode === 'update' && error?.message?.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    console.error(`Error ${mode === 'create' ? 'creating' : 'updating'} tech governance release:`, error);
    return res.status(500).json({
      error: `Failed to ${mode === 'create' ? 'create' : 'update'} tech governance release`,
    });
  }
}

/**
 * POST /api/tech-governance-releases-intake
 * Body: TechGovernanceRelease
 * Adds a new release entry. Persists to artifactory.
 */
router.post('/', requireAuth, (req: Request, res: Response) => {
  upsertRelease(req, res, 'create');
});

/**
 * PUT /api/tech-governance-releases-intake
 * Body: TechGovernanceRelease (the `branch` field is used as the key)
 * Replaces an existing release entry. Persists to artifactory.
 */
router.put('/', requireAuth, (req: Request, res: Response) => {
  upsertRelease(req, res, 'update');
});

/**
 * DELETE /api/tech-governance-releases-intake
 * Body: { branch: string }
 * Removes a release entry. Persists to artifactory.
 */
router.delete('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { branch } = req.body ?? {};

    if (!branch || typeof branch !== 'string') {
      return res.status(400).json({ error: 'Body field "branch" (string) is required' });
    }

    const deleted = await techGovernanceReleasesIntakeService.delete(branch);

    if (!deleted) {
      return res.status(404).json({ error: `Release '${branch}' not found` });
    }

    res.json({ message: 'Release deleted successfully', key: branch });
  } catch (error) {
    console.error('Error deleting tech governance release:', error);
    res.status(500).json({ error: 'Failed to delete tech governance release' });
  }
});

export default router;
