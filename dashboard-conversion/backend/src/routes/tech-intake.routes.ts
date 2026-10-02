import { Router, Request, Response } from 'express';
import jiraService from '../services/jira.service';
import releaseWorkflowService from '../services/release-workflow.service';
import { techGovernanceReleasesIntakeService } from '../services';
import { resolveDATeamsByCodes, codesFromIntakes } from '../services/da-team-resolver.service';
import confluenceExportService, { buildIntakeTitle } from '../services/confluence-export.service';
import ConfluenceService from '../services/confluence.service';
import daTeamsService from '../services/da-teams.service';
import { IntakeFormData } from '../services/intake-template';
import { loadIntakeTemplate } from '../services/intake-template-loader';
import { resolveIntakeParentPageId, getIntakeSpaceKey, buildIntakePageUrl } from '../config/intake-board.config';

const router = Router();

// NO requireAuth on this router — tech intake is open to all users

// In-memory locks to mitigate race conditions when creating intakes
const intakeCreationLocks = new Map<string, Promise<any>>();

function escapeCql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
}

function badRequest(res: Response, msg: string): Response {
  return res.status(400).json({ error: msg });
}

function notFound(res: Response, msg: string): Response {
  return res.status(404).json({ error: msg });
}

/**
 * Resolve a DA team's board key from a step1 payload.
 * Prefer explicit jiraBoardKey, fall back to matching DA team name
 * and using the first jiraProjects entry. Last resort: return the
 * DA team display name.
 */
function resolveBoardKey(step1: { jiraBoardKey?: string; daTeam?: string }): string {
  let boardKey = String(step1?.jiraBoardKey || '').trim();
  if (!boardKey && step1?.daTeam) {
    const all = daTeamsService.getAll();
    const match = Object.values(all).find((t: any) =>
      String(t.name || '').toLowerCase() === String(step1.daTeam || '').toLowerCase()
    );
    if (match && Array.isArray(match.jiraProjects) && match.jiraProjects.length > 0) {
      boardKey = String(match.jiraProjects[0] || '').trim();
    }
  }
  return boardKey || String(step1?.daTeam || '').trim();
}

/**
 * Normalize a stored intake property value into the canonical IntakeFormData shape
 * Handles legacy variants (schemaVersion 2, old step2/step3 split, and schemaVersion 1 with formData wrapper)
 */
function normalizeIntakePropertyValue(rawValue: any) {
  const raw = rawValue || {};
  const src = raw.formData || raw;
  const formData = {
    step1: src.step1 || raw.step1 || {},
    generalValues: src.generalValues || src.step3?.general || {},
    selectedScopes: src.selectedScopes || src.step2?.scopes || [],
    scopeValues: src.scopeValues || (() => {
      if (src.step3) {
        const sv = { ...(src.step3 || {}) } as any;
        delete sv.general;
        return sv;
      }
      return {};
    })(),
    dynamicRows: src.dynamicRows || {},
  };
  return formData;
}

/**
 * GET /api/tech-intake/releases
 * Returns minimal release list (id + title + status) for the intake form dropdowns.
 * Status lets the Create flow hide complete/aborted releases.
 */
router.get('/releases', async (_req: Request, res: Response) => {
  try {
    const releases = Object.values(await releaseWorkflowService.getAll());
    const minimal = (releases || []).map((r: any) => ({ releaseId: r.releaseId, title: r.title, status: r.status }));
    res.json(minimal);
  } catch (error) {
    console.error('Error fetching releases for intake:', error);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});


/**
 * GET /api/tech-intake/da-teams
 * Returns all DA teams (full list for create mode).
 */
router.get('/da-teams', async (_req: Request, res: Response) => {
  try {
    const allTeams = daTeamsService.getAll();
    res.json(allTeams);
  } catch (error) {
    console.error('Error fetching DA teams:', error);
    res.status(500).json({ error: 'Failed to fetch DA teams' });
  }
});

/**
 * GET /api/tech-intake/da-teams/:releaseId
 * Returns DA teams that are part of a specific release (from Tech Governance intake data).
 */
router.get('/da-teams/:releaseId', async (req: Request<{ releaseId: string }>, res: Response) => {
  try {
    const { releaseId } = req.params;
    const entry = techGovernanceReleasesIntakeService.findByBranch(releaseId);
    if (!entry) return res.json({ matched: [], unmatched: [] });
    const resolution = resolveDATeamsByCodes(codesFromIntakes(entry.intakes), entry.intakes);
    res.json(resolution);
  } catch (error) {
    console.error('Error fetching DA teams for release:', error);
    res.status(500).json({ error: 'Failed to fetch DA teams for release' });
  }
});

/**
 * GET /api/tech-intake/users/search?q={query}
 * Proxy to Jira user search API.
 */
router.get('/users/search', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || req.query.query || '');
    if (!q) return badRequest(res, 'Query param "q" is required');
    const users = await jiraService.searchUsers(q);
    const mapped = (Array.isArray(users) ? users : []).map((u: any) => ({
      accountId: u.accountId || u.account_id || null,
      displayName: u.displayName || u.name || '',
      email: u.emailAddress || u.email || '',
    }));
    res.json(mapped);
  } catch (err: any) {
    console.error('Error searching users:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'User search failed' });
  }
});

/**
 * GET /api/tech-intake/intake-template
 * Returns the intake template YAML as JSON.
 */
router.get('/intake-template', async (_req: Request, res: Response) => {
  try {
    const template = loadIntakeTemplate();
    res.json(template);
  } catch (err: any) {
    console.error('Error loading intake template:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to load intake template' });
  }
});

/**
 * GET /api/tech-intake/intake/lookup?release=R95&daTeam=Team+Name
 * Find existing intake pages under the release's parent page.
 */
router.get('/intake/lookup', async (req: Request, res: Response) => {
  // Disable caching — intake pages can be created at any time
  res.set('ETag', '');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const release = String(req.query.release || '').trim();
    const daTeam = String(req.query.daTeam || '').trim();
    const boardKeyQuery = String(req.query.boardKey || '').trim();
    if (!release) return badRequest(res, 'Query param "release" is required');

    const parentPageId = resolveIntakeParentPageId(release);
    if (!parentPageId) return notFound(res, `No intake parent page configured for release "${release}"`);

    const allChildren = await ConfluenceService.getChildPages(String(parentPageId));
    const releaseLower = release.toLowerCase();
    // Resolve board key preference: explicit boardKey query param wins, otherwise
    // resolve from daTeam for backwards compatibility
    const resolvedKey = boardKeyQuery || resolveBoardKey({ daTeam });
    const resolvedKeyLower = String(resolvedKey || '').toLowerCase();

    const filtered = allChildren.filter((page: any) => {
      const title = (page.title || '').toLowerCase();
      if (!title.includes(releaseLower)) return false;
      if (resolvedKeyLower && !title.includes(resolvedKeyLower)) return false;
      return true;
    });

    const pages = filtered.map((page: any) => ({
      pageId: page.id,
      title: page.title,
      url: buildIntakePageUrl(page.id, page.title),
      lastUpdated: page.version?.when || null,
      updatedBy: page.version?.by?.displayName || null,
    }));

    res.json({ release, daTeam, boardKey: resolvedKey, parentPageId, results: pages });
  } catch (err: any) {
    console.error('Error in intake lookup:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Intake lookup failed' });
  }
});

/**
 * GET /api/tech-intake/intake/:pageId/pull
 * Pulls the intake-data content property from a specific page
 */
router.get('/intake/:pageId/pull', async (req: Request<{ pageId: string }>, res: Response) => {
  try {
    const pageId = req.params.pageId;
    const property = await ConfluenceService.getIntakeProperty(pageId);
    if (!property) return notFound(res, `No intake-data property found on page ${pageId}`);

    const formData = normalizeIntakePropertyValue(property.value || {});

    res.json({
      pageId,
      formData,
      createdBy: property.value?.createdBy || { name: property.value?.exportedBy || 'unknown', email: '' },
      exportedBy: property.value?.exportedBy || property.value?.createdBy?.email || 'unknown',
      exportedAt: property.value?.exportedAt || property.value?.metadata?.createdAt || null,
      version: property.version?.number || 1,
      editHistory: property.value?.metadata?.editHistory || [],
    });
  } catch (err: any) {
    console.error('Error pulling intake data:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to pull intake data' });
  }
});

/**
 * GET /api/tech-intake/intakes-by-team/:boardKey
 * Returns all intakes across all releases for a specific DA team (by board key).
 * Used by the Duplicate Intake modal to show previous intakes.
 */
router.get('/intakes-by-team/:boardKey', async (req: Request<{ boardKey: string }>, res: Response) => {
  try {
    const boardKey = String(req.params.boardKey || '').trim();
    if (!boardKey) return badRequest(res, 'Path param "boardKey" is required');

    const allReleasesObj = await releaseWorkflowService.getAll();
    const releases = Object.values(allReleasesObj || []);

    // Parallel fetch child pages for each release's intake parent (skip releases with no parent)
    const perReleasePromises = releases.map(async (r: any) => {
      try {
        const parent = resolveIntakeParentPageId(r.releaseId);
        if (!parent) return [] as any[];
        const children = await ConfluenceService.getChildPages(String(parent));
        const lowerKey = boardKey.toLowerCase();
        const matched = (children || []).filter((p: any) => (String(p.title || '').toLowerCase().includes(lowerKey)));
        return matched.map((p: any) => {
          const titleStr = String(p.title || '');
          const extractedRelease = (titleStr.split(' - ')[0] || '').trim() || r.releaseId;
          return {
            release: extractedRelease,
            title: p.title,
            pageId: p.id,
            url: buildIntakePageUrl(p.id, p.title),
            lastUpdated: p.version?.when || null,
            updatedBy: p.version?.by?.displayName || null,
          };
        });
      } catch (err) {
        console.error(`Failed to fetch intakes for release ${r && r.releaseId}:`, err);
        return [] as any[];
      }
    });

    const perReleaseResults = await Promise.all(perReleasePromises);
    // Flatten and deduplicate by pageId in case multiple releases resolve to the same parent
    const seen = new Set<string>();
    const intakes = perReleaseResults.flat().filter((item: any) => {
      if (!item || !item.pageId) return false;
      if (seen.has(item.pageId)) return false;
      seen.add(item.pageId);
      return true;
    });

    res.json({ boardKey, intakes });
  } catch (err: any) {
    console.error('Error fetching intakes by team:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to fetch intakes by team' });
  }
});

/**
 * POST /api/tech-intake/export
 * Create a new intake page on Confluence.
 */
router.post('/export', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    // Resolve parent from server-side config (ignore frontend values — server is source of truth)
    const release = String(body.step1?.release || body.release || '');
    const parentPageId = String(body.parentPageId || resolveIntakeParentPageId(release) || '');
    const spaceId = String(body.spaceId || getIntakeSpaceKey() || '');

    if (!parentPageId) return notFound(res, `No Tech Governance intake parent page found for release "${release}"`);
    if (!/^[0-9]+$/.test(String(parentPageId))) return badRequest(res, 'Invalid parentPageId');

    // Resolve real user identity from request body if provided, otherwise fall back to session
    const providedUser = req.body?.requestor || req.body?.createdBy || req.body?.exportedBy || req.body?.user || req.body?.selectedUser;
    let createdBy: { name: string; email: string } | null = null;
    if (providedUser && typeof providedUser === 'object' && providedUser.accountId) {
      const searchName = String(providedUser.displayName || providedUser.name || providedUser.email || '');
      if (!searchName) return badRequest(res, 'User identity must include a name or email');
      try {
        const searchResults = await jiraService.searchUsers(searchName);
        const match = (Array.isArray(searchResults) ? searchResults : []).find(
          (u: any) => (u.accountId || u.account_id) === String(providedUser.accountId),
        );
        if (!match) return badRequest(res, 'Invalid user — accountId not found in Jira');
        createdBy = {
          name: match.displayName || String(providedUser.displayName || providedUser.name || 'unknown'),
          email: match.emailAddress || String(providedUser.email || ''),
        };
      } catch (err) {
        console.error('User validation search failed:', err);
        return badRequest(res, 'Could not verify user identity');
      }
    } else if ((req as any).user) {
      createdBy = { name: (req as any).user?.displayName || (req as any).user?.name || (req as any).user?.email || 'unknown', email: (req as any).user?.email || '' };
    } else {
      return badRequest(res, 'A user identity is required (select your name from the dropdown)');
    }

    // Normalize payload into IntakeFormData for both full-form and legacy flows
    let formData: IntakeFormData;
    if (Array.isArray(body.selectedScopes) || typeof body.generalValues === 'object') {
      formData = {
        step1: {
          daTeam: String(body.step1?.daTeam || body.daTeam || ''),
          release: String(body.step1?.release || body.release || ''),
          jiraBoardKey: String(body.step1?.jiraBoardKey || body.jiraBoardKey || ''),
          intakeTitle: String(body.step1?.intakeTitle || body.intakeTitle || ''),
        },
        generalValues: (body.generalValues || {}),
        selectedScopes: Array.isArray(body.selectedScopes) ? body.selectedScopes.map(String) : [],
        scopeValues: (body.scopeValues || {}),
        dynamicRows: (body.dynamicRows || {}),
      };
    } else {
      const daTeam = String(body.daTeam || '');
      const release = String(body.release || '');
      const jiraBoardKey = String(body.jiraBoardKey || '');
      const rawIntakeTitle = String(body.intakeTitle || '');
      const legacyDefault = `${release} - ${daTeam}`;
      // Treat intakeTitle as an optional suffix; if the client submitted the legacy
      // default ("<release> - <daTeam>"), treat it as empty so we rebuild using the board key.
      const intakeTitle = rawIntakeTitle && rawIntakeTitle !== legacyDefault ? rawIntakeTitle : '';
      if (!daTeam) return badRequest(res, 'Body field "daTeam" is required');
      if (!release) return badRequest(res, 'Body field "release" is required');
      formData = {
        step1: { daTeam, release, jiraBoardKey, intakeTitle },
        generalValues: {},
        selectedScopes: [],
        scopeValues: {},
        dynamicRows: {},
      };
    }

    if (!formData.step1.daTeam) return badRequest(res, 'Body field "step1.daTeam" is required');
    if (!formData.step1.release) return badRequest(res, 'Body field "step1.release" is required');

    // Acquire per-release+team lock to mitigate race conditions
    // Use resolved board key (prefer jiraBoardKey, then DA team mapping)
    const resolvedBoardKeyForLock = resolveBoardKey({ jiraBoardKey: formData.step1.jiraBoardKey, daTeam: formData.step1.daTeam });
    const lockKey = `${formData.step1.release}::${resolvedBoardKeyForLock}`.toLowerCase();
    const existingLock = intakeCreationLocks.get(lockKey);
    if (existingLock) {
      try { await existingLock; } catch { /* ignore */ }
    }

    const creationPromise = (async () => {
      // Duplicate detection using exact title match
      const expectedTitle = buildIntakeTitle(formData.step1);
      try {
        const cql = `type = page AND ancestor = ${parentPageId} AND title = "${escapeCql(expectedTitle)}"`;
        const existing = await ConfluenceService.searchByCql(cql);
        if (existing && existing.length > 0) {
          const p = existing[0];
          return { exists: true, pageId: p.id, title: p.title, url: buildIntakePageUrl(p.id, p.title) };
        }
      } catch (err) {
        console.error('Duplicate check failed:', err);
      }

      // Proceed to render and create the page
      const rendered = confluenceExportService.renderFromFullForm(formData, createdBy as any);
      const resp = await confluenceExportService.createIntakePage(parentPageId, spaceId, rendered.title, rendered.body);
      const pageId = resp?.id || resp?.results?.id || resp?.data?.id || resp?.pageId || null;
      if (pageId) {
        try {
          await ConfluenceService.storeIntakeProperty(String(pageId), formData, createdBy as any);
        } catch (err: any) {
          console.error('Failed to store intake property on Confluence page:', err?.response?.data ?? err?.message ?? err);
        }
        try {
          await ConfluenceService.lockPage(String(pageId));
        } catch (err: any) {
          console.error('Failed to lock Confluence page after export:', err?.response?.data ?? err?.message ?? err);
        }
      }
      const pageTitle = rendered.title || '';
      const pageUrl = buildIntakePageUrl(String(pageId), pageTitle);
      return { created: true, page: resp, pageUrl };
    })();

    intakeCreationLocks.set(lockKey, creationPromise);
    try {
      const result = await creationPromise;
      if (result && result.exists) {
        return res.status(409).json(result);
      }
      return res.json(result);
    } finally {
      intakeCreationLocks.delete(lockKey);
    }
  } catch (err: any) {
    console.error('Export error details:', JSON.stringify(err?.response?.data || err?.message, null, 2));
    console.error('Error in export-intake:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Export failed' });
  }
});

/**
 * POST /api/tech-intake/intake/:pageId/push
 * Update an existing intake page on Confluence.
 */
router.post('/intake/:pageId/push', async (req: Request<{ pageId: string }>, res: Response) => {
  try {
    const pageId = req.params.pageId;
    const { step1, generalValues, selectedScopes, scopeValues, dynamicRows } = req.body || {};
    // Resolve editor identity
    const providedEditor = req.body?.editedBy || req.body?.editor || req.body?.user || req.body?.selectedUser;
    let editedBy: { name: string; email: string } | null = null;
    if (providedEditor && typeof providedEditor === 'object' && providedEditor.accountId) {
      const searchName = String(providedEditor.displayName || providedEditor.name || providedEditor.email || '');
      if (!searchName) return badRequest(res, 'User identity must include a name or email');
      try {
        const searchResults = await jiraService.searchUsers(searchName);
        const match = (Array.isArray(searchResults) ? searchResults : []).find(
          (u: any) => (u.accountId || u.account_id) === String(providedEditor.accountId),
        );
        if (!match) return badRequest(res, 'Invalid user — accountId not found in Jira');
        editedBy = {
          name: match.displayName || String(providedEditor.displayName || providedEditor.name || 'unknown'),
          email: match.emailAddress || String(providedEditor.email || ''),
        };
      } catch (err) {
        console.error('User validation search failed:', err);
        return badRequest(res, 'Could not verify user identity');
      }
    } else if ((req as any).user) {
      editedBy = { name: (req as any).user?.displayName || (req as any).user?.name || (req as any).user?.email || 'unknown', email: (req as any).user?.email || '' };
    } else {
      return badRequest(res, 'A user identity is required (select your name from the dropdown)');
    }

    const pageInfo = await ConfluenceService.getPageVersion(pageId);
    if (!pageInfo) return notFound(res, `Page ${pageId} not found in Confluence`);

    const currentProperty = await ConfluenceService.getIntakeProperty(pageId);
    const propertyVersion = currentProperty?.version?.number || 1;

    const formData = { step1, generalValues, selectedScopes, scopeValues, dynamicRows };
    // Preserve original creator from stored property where possible (do NOT fall back to editor)
    const preservedCreatedBy = currentProperty?.value?.createdBy ?? null;
    // Determine lastUpdatedBy only when the editor differs from the original creator AND both have accountIds
    let lastUpdatedBy: { displayName?: string; accountId?: string; date?: string } | undefined = undefined;
    try {
      const creatorAccountId = preservedCreatedBy?.accountId ?? null;
      const editorAccountId = (req.body.editedBy || req.body.editor || req.body.selectedUser)?.accountId ?? null;
      // Show lastUpdatedBy UNLESS we can confirm the editor IS the creator
      const confirmedSameUser = creatorAccountId && editorAccountId && creatorAccountId === editorAccountId;
      if (editorAccountId && !confirmedSameUser) {
        lastUpdatedBy = { displayName: editedBy.name, accountId: editorAccountId, date: new Date().toISOString() };
      }
    } catch (e) {
      lastUpdatedBy = undefined;
    }

    const rendered = confluenceExportService.renderFromFullForm(formData, preservedCreatedBy as any, lastUpdatedBy);

    await ConfluenceService.updatePage(pageId, {
      title: rendered.title,
      body: rendered.body,
      version: pageInfo.version.number + 1,
      versionMessage: `Updated via CDB Dashboard by ${editedBy.name}`,
    });

    const fieldsChanged = Array.isArray(req.body.fieldsChanged) ? req.body.fieldsChanged.slice(0, 50) : [];
    const auditEntry = {
      editedBy: {
        name: editedBy.name,
        email: editedBy.email,
        accountId: (req.body.editedBy || req.body.editor || req.body.selectedUser)?.accountId || '',
      },
      editedAt: new Date().toISOString(),
      fieldsChanged: fieldsChanged.map((c: any) => ({
        field: String(c.field || ''),
        label: String(c.label || c.field || ''),
        section: String(c.section || ''),
        // Preserve null to indicate parent unchanged (sub-only case)
        oldValue: c.oldValue ?? null,
        newValue: c.newValue ?? null,
        // Preserve nested sub-field changes if present
        subChanges: Array.isArray(c.subChanges)
          ? c.subChanges.map((s: any) => ({
              field: String(s.field || ''),
              label: String(s.label || s.field || ''),
              oldValue: s.oldValue ?? '—',
              newValue: s.newValue ?? '—',
            }))
          : undefined,
      })),
    };
    const previousHistory = currentProperty?.value?.metadata?.editHistory || [];
    const updatedPropertyValue = {
      schemaVersion: 2,
      exportedAt: currentProperty?.value?.exportedAt ?? null,
      exportedBy: currentProperty?.value?.exportedBy ?? null,
      createdBy: currentProperty?.value?.createdBy ?? null,
      step1: step1,
      generalValues: generalValues || {},
      selectedScopes: Array.isArray(selectedScopes) ? selectedScopes : [],
      scopeValues: scopeValues || {},
      dynamicRows: dynamicRows || {},
      // persist lastUpdatedBy for downstream consumers
      lastUpdatedBy: lastUpdatedBy || null,
      metadata: {
        createdBy: currentProperty?.value?.metadata?.createdBy ?? null,
        createdAt: currentProperty?.value?.metadata?.createdAt ?? null,
        lastModifiedBy: editedBy.name,
        lastModifiedAt: new Date().toISOString(),
        lastUpdatedBy: lastUpdatedBy ? `${lastUpdatedBy.displayName || ''} on ${lastUpdatedBy.date || ''}` : undefined,
        editHistory: [...previousHistory, auditEntry],
      },
    };

    await ConfluenceService.updateIntakeProperty(pageId, updatedPropertyValue, propertyVersion);

    const pageUrl = buildIntakePageUrl(pageId, (rendered.title || '').replace(/[\s\u00A0\u200B]+$/g, ''));
    res.json({ success: true, pageId, pageUrl, updatedAt: auditEntry.editedAt, updatedBy: editedBy.name, version: pageInfo.version.number + 1 });
  } catch (err: any) {
    if (err?.response?.status === 409) {
      console.error('Confluence version conflict on push:', err?.message);
      return res.status(409).json({ error: 'Version conflict — the page was modified since you loaded it. Please re-pull and try again.' });
    }
    console.error('Error pushing intake update:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to push intake update' });
  }
});

export default router;
