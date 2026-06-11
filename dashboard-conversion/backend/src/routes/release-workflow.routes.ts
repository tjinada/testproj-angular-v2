import { Router, Request, Response } from 'express';
import releaseWorkflowService from '../services/release-workflow.service';
import appDataService from '../services/app-data.service';
import { requireAuth } from '../middleware/auth';
import { ReleaseComponents, ReleaseType, SubStepSource, SubStepState } from '../models/release-workflow.model';

const router = Router();

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

function isReleaseComponents(v: unknown): v is Partial<ReleaseComponents> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const candidate = v as Record<string, unknown>;
  const cdbui = candidate['cdbui'];
  const cdbbos = candidate['cdbbos'];
  return (cdbui === undefined || typeof cdbui === 'boolean')
    && (cdbbos === undefined || typeof cdbbos === 'boolean');
}

function releaseIdFormatExample(type: ReleaseType): string {
  switch (type) {
    case 'bundle':
      return 'R89';
    case 'independent':
      return 'R89.1';
    case 'hotfix':
      return 'R89.0.1';
  }
}

function releaseIdMatchesType(releaseId: string, type: ReleaseType): boolean {
  const trimmed = releaseId.trim();
  switch (type) {
    case 'bundle':
      return /^R\d+$/i.test(trimmed);
    case 'independent':
      return /^R\d+\.\d+$/i.test(trimmed);
    case 'hotfix':
      return /^R\d+\.\d+\.\d+$/i.test(trimmed);
  }
}

function validateReleaseIdForType(res: Response, releaseId: string, type: ReleaseType): Response | null {
  if (releaseIdMatchesType(releaseId, type)) return null;
  return badRequest(
    res,
    `Release ID must match the selected release type. Expected format for ${type} is ${releaseIdFormatExample(type)}.`,
  );
}

function normalizeSheriffValue(value: string | null | undefined): string | null {
  return appDataService.normalizeAdminUsername(value);
}

function validateRequiredSheriff(res: Response, fieldName: string, value: unknown): string | null {
  if (typeof value !== 'string') {
    badRequest(res, `Body field "${fieldName}" (string) is required`);
    return null;
  }

  const normalized = normalizeSheriffValue(value);
  if (!normalized || !appDataService.isAdminUsername(normalized)) {
    badRequest(res, `Body field "${fieldName}" must match an admin username`);
    return null;
  }

  return normalized;
}

function validateOptionalSheriff(res: Response, fieldName: string, value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    badRequest(res, `Body field "${fieldName}" must be a string or null`);
    return undefined;
  }

  const normalized = normalizeSheriffValue(value);
  if (!normalized) return null;
  if (!appDataService.isAdminUsername(normalized)) {
    badRequest(res, `Body field "${fieldName}" must match an admin username`);
    return undefined;
  }

  return normalized;
}

// ----- GET /api/release-workflow -----

/**
 * GET /api/release-workflow
 * Returns all releases as an array.
 */
router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const releases = Object.values(await releaseWorkflowService.getAll());
    res.json(releases);
  } catch (error) {
    console.error('Error fetching release workflow data:', error);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

// ----- GET /api/release-workflow/:releaseId -----

router.get('/:releaseId', requireAuth, async (req: Request<ReleaseParams>, res: Response) => {
  try {
    const { releaseId } = req.params;
    const release = await releaseWorkflowService.getById(releaseId);
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
 * Body: { releaseId, title, type, uiSheriff?, uiBackupSheriff?, bosSheriff?, bosBackupSheriff?, releaseComponents?, metadata? }
 * Creates a new release seeded from the stage template.
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      releaseId,
      title,
      type,
      uiSheriff,
      uiBackupSheriff,
      bosSheriff,
      bosBackupSheriff,
      releaseComponents,
      metadata,
    } = req.body ?? {};

    if (!releaseId || typeof releaseId !== 'string') return badRequest(res, 'Body field "releaseId" (string) is required');
    if (!title || typeof title !== 'string')         return badRequest(res, 'Body field "title" (string) is required');
    if (!isReleaseType(type))                         return badRequest(res, 'Body field "type" must be "bundle" | "independent" | "hotfix"');
    const releaseIdTypeError = validateReleaseIdForType(res, releaseId, type);
    if (releaseIdTypeError) return releaseIdTypeError;
    if (releaseComponents !== undefined && !isReleaseComponents(releaseComponents)) {
      return badRequest(res, 'Body field "releaseComponents" must be an object with boolean cdbui/cdbbos flags');
    }
    if (releaseComponents !== undefined && !releaseComponents.cdbui && !releaseComponents.cdbbos) {
       return badRequest(res, 'Body field "releaseComponents" must enable at least one of "cdbui" or "cdbbos"');
     }
    const normalizedUiSheriff = validateOptionalSheriff(res, 'uiSheriff', uiSheriff);
    if (uiSheriff !== undefined && normalizedUiSheriff === undefined) return;
    const normalizedUiBackupSheriff = validateOptionalSheriff(res, 'uiBackupSheriff', uiBackupSheriff);
    if (uiBackupSheriff !== undefined && normalizedUiBackupSheriff === undefined) return;
    const normalizedBosSheriff = validateOptionalSheriff(res, 'bosSheriff', bosSheriff);
    if (bosSheriff !== undefined && normalizedBosSheriff === undefined) return;
    const normalizedBosBackupSheriff = validateOptionalSheriff(res, 'bosBackupSheriff', bosBackupSheriff);
    if (bosBackupSheriff !== undefined && normalizedBosBackupSheriff === undefined) return;

    if (releaseComponents?.cdbui && !normalizedUiSheriff) {
      return badRequest(res, 'Body field "uiSheriff" must match an admin username when CDB UI is selected');
    }
    if (releaseComponents?.cdbbos && !normalizedBosSheriff) {
      return badRequest(res, 'Body field "bosSheriff" must match an admin username when CDB BOS is selected');
    }

    const release = await releaseWorkflowService.add({
      releaseId,
      title,
      type,
      uiSheriff: normalizedUiSheriff,
      uiBackupSheriff: normalizedUiBackupSheriff,
      bosSheriff: normalizedBosSheriff,
      bosBackupSheriff: normalizedBosBackupSheriff,
      releaseComponents,
      metadata,
    });
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
 * Updates top-level release metadata.
 */
router.put('/:releaseId', requireAuth, async (req: Request<ReleaseParams>, res: Response) => {
  try {
    const { releaseId } = req.params;
    const body = req.body ?? {};
    const patch = { ...body } as Record<string, unknown>;

    for (const key of ['uiSheriff', 'bosSheriff'] as const) {
      if (!(key in patch)) continue;
      const normalized = validateRequiredSheriff(res, key, patch[key]);
      if (normalized === null) return;
      patch[key] = normalized;
    }

    for (const key of ['uiBackupSheriff', 'bosBackupSheriff'] as const) {
      if (!(key in patch)) continue;
      const normalized = validateOptionalSheriff(res, key, patch[key]);
      if (normalized === undefined) return;
      patch[key] = normalized;
    }

    const updated = await releaseWorkflowService.update(releaseId, patch);
    res.json({ message: 'Release updated successfully', release: updated });
  } catch (error: any) {
    if (error?.message?.includes('not found')) {
      return notFound(res, error.message);
    }
    console.error('Error updating release:', error);
    res.status(500).json({ error: 'Failed to update release' });
  }
});

/**
 * PUT /api/release-workflow/:releaseId/stages/:stageId/sub-steps/:subStepId
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
      if (error?.message?.includes('Bundle releases cannot be skipped')) {
        return badRequest(res, error.message);
      }
      console.error('Error updating sub-step:', error);
      res.status(500).json({ error: 'Failed to update sub-step' });
    }
  },
);

router.put(
  '/:releaseId/stages/:stageId/na',
  requireAuth,
  async (req: Request<StageParams>, res: Response) => {
    try {
      const { releaseId, stageId } = req.params;
      const { na, actor } = req.body ?? {};
      if (typeof na !== 'boolean') {
        return badRequest(res, 'Body field "na" must be a boolean');
      }
      if (actor !== undefined && typeof actor !== 'string') {
        return badRequest(res, 'Body field "actor" must be a string');
      }

      const stage = await releaseWorkflowService.setStageNa(releaseId, stageId, na, actor);
      res.json({ message: 'Stage updated', stage });
    } catch (error: any) {
      if (error?.message?.includes('not found')) {
        return notFound(res, error.message);
      }
      if (error?.message?.includes('Bundle releases cannot be skipped')) {
        return badRequest(res, error.message);
      }
      if (error?.message?.includes('cannot be updated with stage-level N/A')) {
        return badRequest(res, error.message);
      }
      console.error('Error updating stage N/A:', error);
      res.status(500).json({ error: 'Failed to update stage' });
    }
  },
);

// ----- PATCH /api/release-workflow/:releaseId/metadata -----

/**
 * PATCH /api/release-workflow/:releaseId/metadata
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
      if (error?.message?.includes('Could not parse a Confluence page ID from URL')) {
        return badRequest(res, error.message);
      }
      if (error?.message?.includes('does not exist or could not be fetched')) {
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
 * Triggers automated checks for a stage.
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