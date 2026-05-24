/**
 * Release Workflow — routes
 *
 * All endpoints mounted at /api/release-workflow, protected by requireAuth.
 * Mirrors the tech-governance-releases-intake.routes.ts pattern from the
 * production CDB Dashboard repo.
 *
 * NOTE: requireAuth middleware is imported from a path that exists in the
 * production repo. This dashboard-conversion folder does not include it;
 * the import resolves at merge-time.
 */

import { Router, Request, Response } from 'express';
import releaseWorkflowService from '../services/release-workflow.service';
import { requireAuth } from '../middleware/auth';
import { ReleaseType, SubStepSource, SubStepState } from '../models/release-workflow.model';

const router = Router();

// ----- param-shape types so req.params.X narrows to string -----

type ReleaseParams  = { releaseId: string };
type StageParams    = { releaseId: string; stageId: string };
type SubStepParams  = { releaseId: string; stageId: string; subStepId: string };

// ----- helpers -----

function badRequest(res: Response, msg: string): Response {
  return res.status(400).json({ error: msg });
}

function notFound(res: Response, msg: string): Response {
  return res.status(404).json({ error: msg });
}

function isReleaseType(v: unknown): v is ReleaseType {
  return v === 'bundle' || v === 'independent' || v === 'hotfix';
}

function isSubStepState(v: unknown): v is SubStepState {
  return v === 'unchecked' || v === 'checked' || v === 'n_a';
}

function isSubStepSource(v: unknown): v is SubStepSource {
  return v === 'manual' || v === 'auto' || v === null;
}

// ----- GET /api/release-workflow -----

/**
 * GET /api/release-workflow
 * Returns all releases as an array.
 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  try {
    const releases = Object.values(releaseWorkflowService.getAll());
    res.json(releases);
  } catch (error) {
    console.error('Error fetching release workflow data:', error);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

// ----- GET /api/release-workflow/:releaseId -----

router.get('/:releaseId', requireAuth, (req: Request<ReleaseParams>, res: Response) => {
  try {
    const { releaseId } = req.params;
    const release = releaseWorkflowService.getById(releaseId);
    if (!release) return notFound(res, `Release '${releaseId}' not found`);
    res.json(release);
  } catch (error) {
    console.error('Error fetching release:', error);
    res.status(500).json({ error: 'Failed to fetch release' });
  }
});

// ----- POST /api/release-workflow -----

/**
 * POST /api/release-workflow
 * Body: { releaseId, title, type, sheriff, metadata? }
 * Creates a new release seeded from the stage template.
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { releaseId, title, type, sheriff, metadata } = req.body ?? {};

    if (!releaseId || typeof releaseId !== 'string') return badRequest(res, 'Body field "releaseId" (string) is required');
    if (!title || typeof title !== 'string')         return badRequest(res, 'Body field "title" (string) is required');
    if (!isReleaseType(type))                         return badRequest(res, 'Body field "type" must be "bundle" | "independent" | "hotfix"');
    if (!sheriff || typeof sheriff !== 'string')     return badRequest(res, 'Body field "sheriff" (string) is required');

    const release = await releaseWorkflowService.add({ releaseId, title, type, sheriff, metadata });
    res.status(201).json({ message: 'Release created successfully', release });
  } catch (error: any) {
    if (error?.message?.includes('already exists')) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Error creating release:', error);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

// ----- PUT /api/release-workflow/:releaseId -----

/**
 * PUT /api/release-workflow/:releaseId
 * Body: partial { title, sheriff, metadata, status }
 * Updates top-level release metadata.
 */
router.put('/:releaseId', requireAuth, async (req: Request<ReleaseParams>, res: Response) => {
  try {
    const { releaseId } = req.params;
    const updated = await releaseWorkflowService.update(releaseId, req.body ?? {});
    res.json({ message: 'Release updated successfully', release: updated });
  } catch (error: any) {
    if (error?.message?.includes('not found')) {
      return notFound(res, error.message);
    }
    console.error('Error updating release:', error);
    res.status(500).json({ error: 'Failed to update release' });
  }
});

// ----- PUT /api/release-workflow/:releaseId/stages/:stageId/sub-steps/:subStepId -----

/**
 * PUT /api/release-workflow/:releaseId/stages/:stageId/sub-steps/:subStepId
 * Body: { state, source, actor? }
 * Toggles a sub-step's state.
 */
router.put(
  '/:releaseId/stages/:stageId/sub-steps/:subStepId',
  requireAuth,
  async (req: Request<SubStepParams>, res: Response) => {
    try {
      const { releaseId, stageId, subStepId } = req.params;
      const { state, source, actor } = req.body ?? {};
      if (!isSubStepState(state))   return badRequest(res, 'Body field "state" must be "unchecked" | "checked" | "n_a"');
      if (!isSubStepSource(source)) return badRequest(res, 'Body field "source" must be "manual" | "auto" | null');

      const subStep = await releaseWorkflowService.updateSubStep(
        releaseId,
        stageId,
        subStepId,
        { state, source, actor },
      );
      res.json({ message: 'Sub-step updated', subStep });
    } catch (error: any) {
      if (error?.message?.includes('not found')) {
        return notFound(res, error.message);
      }
      console.error('Error updating sub-step:', error);
      res.status(500).json({ error: 'Failed to update sub-step' });
    }
  },
);

// ----- PATCH /api/release-workflow/:releaseId/metadata -----

/**
 * PATCH /api/release-workflow/:releaseId/metadata
 * Body: a flat record of { fieldPath: value | null }, e.g.
 *   { "intakePageId": "1110606115", "branches.cdbUiConfigs": "https://github.com/..." }
 *
 * Persists each field then re-runs the checks for any stages that reference
 * any of the changed fields. Returns the updated release.
 */
router.patch(
  '/:releaseId/metadata',
  requireAuth,
  async (req: Request<ReleaseParams>, res: Response) => {
    try {
      const { releaseId } = req.params;
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return badRequest(res, 'Body must be an object of { fieldPath: value }');
      }
      // Separate the actor (used for attribution on auto-ticks) from the
      // field patch itself. Everything except 'actor' is treated as a field
      // to update.
      const { actor, ...patch } = body as Record<string, unknown>;
      if (actor !== undefined && typeof actor !== 'string') {
        return badRequest(res, 'Body field "actor" must be a string');
      }
      // Sanity-check value types.
      for (const [key, value] of Object.entries(patch)) {
        if (value !== null && typeof value !== 'string') {
          return badRequest(res, `Field '${key}' must be a string or null`);
        }
      }
      const release = await releaseWorkflowService.updateMetadata(
        releaseId,
        patch as Record<string, string | null>,
        actor,
      );
      res.json({ message: 'Metadata updated', release });
    } catch (error: any) {
      if (error?.message?.includes('not found')) {
        return notFound(res, error.message);
      }
      if (error?.message?.includes('Unknown')) {
        return badRequest(res, error.message);
      }
      console.error('Error updating metadata:', error);
      res.status(500).json({ error: 'Failed to update metadata' });
    }
  },
);

// ----- POST /api/release-workflow/:releaseId/stages/:stageId/run-checks -----

/**
 * POST /api/release-workflow/:releaseId/stages/:stageId/run-checks
 *
 * Triggers automated checks for a stage.
 * SKELETON: returns the stage's existing automatedChecks unchanged.
 * Per-stage owners implement real check execution in the service.
 */
router.post(
  '/:releaseId/stages/:stageId/run-checks',
  requireAuth,
  async (req: Request<StageParams>, res: Response) => {
    try {
      const { releaseId, stageId } = req.params;
      const checks = await releaseWorkflowService.runChecks(releaseId, stageId);
      res.json({ checks });
    } catch (error: any) {
      if (error?.message?.includes('not found')) {
        return notFound(res, error.message);
      }
      console.error('Error running checks:', error);
      res.status(500).json({ error: 'Failed to run checks' });
    }
  },
);

// ----- DELETE /api/release-workflow/:releaseId -----

router.delete('/:releaseId', requireAuth, async (req: Request<ReleaseParams>, res: Response) => {
  try {
    const { releaseId } = req.params;
    const deleted = await releaseWorkflowService.delete(releaseId);
    if (!deleted) return notFound(res, `Release '${releaseId}' not found`);
    res.json({ message: 'Release deleted successfully', releaseId });
  } catch (error) {
    console.error('Error deleting release:', error);
    res.status(500).json({ error: 'Failed to delete release' });
  }
});

export default router;
