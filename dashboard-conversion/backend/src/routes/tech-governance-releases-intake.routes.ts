import { Router, Request, Response } from 'express';
import techGovernanceReleasesIntakeService, {
  IntakeWithGateStatus,
  TechGovernanceRelease,
  TechGovernanceReleaseIntake,
} from '../services/tech-governance-releases-intake.service';
import intakeApprovalService, { IntakeApprovalError } from '../services/intake-approval.service';
import releaseWorkflowService from '../services/release-workflow.service';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Release Workflow states whose intakes no longer need discussing
const CLOSED_RELEASE_STATUSES = ['complete', 'aborted'];

function resolveActor(req: Request): string {
  const fromBody = typeof req.body?.actor === 'string' ? req.body.actor.trim() : '';
  const user = (req as any).user;
  return fromBody || user?.username || user?.email || user?.name || 'platform';
}

function sendApprovalError(res: Response, error: any, action: 'approve' | 'revoke'): Response {
  if (error instanceof IntakeApprovalError) {
    return res.status(error.status).json({ error: error.message });
  }
  const upstream = error?.response?.status;
  if (upstream === 403) return res.status(403).json({ error: 'Service account cannot edit this Confluence page' });
  if (upstream === 404) return res.status(404).json({ error: 'Intake page not found in Confluence' });
  if (upstream === 409) {
    return res.status(409).json({ error: 'The Confluence page changed while saving. Refresh and try again.' });
  }
  console.error(`Error trying to ${action} tech governance intake:`, error?.response?.data ?? error?.message ?? error);
  return res.status(upstream ? 502 : 500).json({ error: `Failed to ${action} intake` });
}

/**
 * GET /api/tech-governance-releases-intake
 * Returns the cached tech governance releases intake data, with each intake's PR gate status.
 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const releases = Object.values(techGovernanceReleasesIntakeService.getAll())
      .map((release) => techGovernanceReleasesIntakeService.withGateStatus(release, now));
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
        const stored = techGovernanceReleasesIntakeService.getByBranch(branch)?.intakes ?? [];
        const submitted: TechGovernanceReleaseIntake[] = Array.isArray(req.body.intakes) ? req.body.intakes : [];
        intakes = techGovernanceReleasesIntakeService.mergeStoredIntakeFields(intakes, stored).map((intake) => {
          // platformVeto is edited from the admin UI and sent back in the body
          const updatedIntake = submitted.find((i) => i.id === intake.id);
          if (updatedIntake && typeof updatedIntake.platformVeto === 'number') {
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
      return res.status(201).json({
        message: 'Release created successfully',
        release: techGovernanceReleasesIntakeService.withGateStatus(created),
      });
    }

    const updated = await techGovernanceReleasesIntakeService.update(branch, filteredData);
    return res.json({
      message: 'Release updated successfully',
      release: techGovernanceReleasesIntakeService.withGateStatus(updated),
    });
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

/**
 * POST /api/tech-governance-releases-intake/intakes/approve
 * Body: { branch: string, intakeId: string, date: 'YYYY-MM-DD', actor?: string }
 * Writes "Discussed in Tech Governance Meeting on <date>" to the intake page.
 */
router.post('/intakes/approve', requireAuth, async (req: Request, res: Response) => {
  try {
    const { branch, intakeId, date } = req.body ?? {};
    if (!branch || typeof branch !== 'string') {
      return res.status(400).json({ error: 'Body field "branch" (string) is required' });
    }
    if (!intakeId || typeof intakeId !== 'string') {
      return res.status(400).json({ error: 'Body field "intakeId" (string) is required' });
    }
    if (!date || typeof date !== 'string') {
      return res.status(400).json({ error: 'Body field "date" (YYYY-MM-DD) is required' });
    }
    const release = await intakeApprovalService.approve(branch, intakeId, date, resolveActor(req));
    return res.json({ message: 'Intake approved', release: techGovernanceReleasesIntakeService.withGateStatus(release) });
  } catch (error: any) {
    return sendApprovalError(res, error, 'approve');
  }
});

/**
 * POST /api/tech-governance-releases-intake/intakes/revoke
 * Body: { branch: string, intakeId: string, actor?: string }
 * Removes the "Discussed in Tech Governance Meeting" line from the intake page.
 */
router.post('/intakes/revoke', requireAuth, async (req: Request, res: Response) => {
  try {
    const { branch, intakeId } = req.body ?? {};
    if (!branch || typeof branch !== 'string') {
      return res.status(400).json({ error: 'Body field "branch" (string) is required' });
    }
    if (!intakeId || typeof intakeId !== 'string') {
      return res.status(400).json({ error: 'Body field "intakeId" (string) is required' });
    }
    const release = await intakeApprovalService.revoke(branch, intakeId, resolveActor(req));
    return res.json({ message: 'Approval revoked', release: techGovernanceReleasesIntakeService.withGateStatus(release) });
  } catch (error: any) {
    return sendApprovalError(res, error, 'revoke');
  }
});

/**
 * GET /api/tech-governance-releases-intake/awaiting-discussion
 * Pending intakes (in grace or blocking PRs) across releases that are still open in Release Workflow.
 * Blocking first (longest blocked first), then in-grace by least time left.
 */
router.get('/awaiting-discussion', requireAuth, async (_req: Request, res: Response) => {
  try {
    const workflowReleases = Object.values(await releaseWorkflowService.getAll());
    const now = new Date();
    const seen = new Set<string>();
    const items: Array<{ branch: string; intake: IntakeWithGateStatus }> = [];

    for (const workflowRelease of workflowReleases) {
      if (CLOSED_RELEASE_STATUSES.includes(workflowRelease.status)) continue;
      const release = techGovernanceReleasesIntakeService.findByBranch(workflowRelease.releaseId);
      if (!release || seen.has(release.branch)) continue;
      seen.add(release.branch);
      for (const intake of techGovernanceReleasesIntakeService.withGateStatus(release, now).intakes) {
        if (intake.gateStatus.state === 'grace' || intake.gateStatus.state === 'blocking') {
          items.push({ branch: release.branch, intake });
        }
      }
    }

    items.sort((a, b) => {
      const sa = a.intake.gateStatus;
      const sb = b.intake.gateStatus;
      if (sa.state !== sb.state) return sa.state === 'blocking' ? -1 : 1;
      if (sa.state === 'grace') return (sa.graceDaysLeft ?? 0) - (sb.graceDaysLeft ?? 0);
      return (sa.graceEndsOn ?? '').localeCompare(sb.graceEndsOn ?? '');
    });

    res.json(items);
  } catch (error) {
    console.error('Error fetching intakes awaiting discussion:', error);
    res.status(500).json({ error: 'Failed to fetch intakes awaiting discussion' });
  }
});

export default router;
