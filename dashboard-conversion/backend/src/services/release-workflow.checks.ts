/**
 * Release Workflow — single source of truth
 *
 * One file owns everything stage-related: the workflow shape (stages,
 * sub-steps, checks, dependencies) AND the runners that execute each check.
 *
 * Stage owners spend nearly all their time in the STAGE_DEFINITIONS array
 * at the top of this file. Adding a check or sub-step is one line in one
 * place; the template structure and the runner registration are derived
 * from the same entry, so they can never drift.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  How to:
 * ─────────────────────────────────────────────────────────────────────────
 *  - Add a sub-step      → add a SubStepDef to a stage's `subSteps` array
 *  - Add a check         → add a CheckDef to a stage's `checks` array
 *  - Wire auto-tick      → on the sub-step, set autoTickedBy: ['check-id']
 *  - Add a new pattern   → add a factory below (after STAGE_DEFINITIONS)
 *  - Add a metadata field → add to ReleaseMetadata in the model (FieldPath
 *                           extends automatically)
 *
 *  Every factory accepts `field: FieldPath` — either a top-level metadata
 *  field name (e.g. 'fixVersion') or a nested branches path (e.g.
 *  'branches.cdbUiConfigs').
 *
 *  Result-shape conventions (frontend formatters detect by shape):
 *    Confluence page  → { pageId, title, webui }
 *    JIRA fix version → { id, name, projectKey, released }
 *    JIRA issue       → { key, summary, status }
 *    GitHub PR        → { prNumber, title, state, url }
 *    GitHub branch    → { branchName, owner, repo, sha }
 *    valueIsSet       → { [fieldName]: value }
 */

import confluenceService from './confluence.service';
import jiraService from './jira.service';
import githubService from './github.service';
import {
  AutomatedCheck,
  Release,
  ReleaseMetadata,
  Stage,
  StageKind,
  StageStatus,
  SubStep,
} from '../models/release-workflow.model';

// ============================================================================
// Types — exported so the service can consume them
// ============================================================================

export type CheckRunner = (release: Release, check: AutomatedCheck) => Promise<AutomatedCheck>;
export type StageRunnerMap = Record<string, CheckRunner>;

/**
 * Allowed field paths for factories.
 *
 * - Top-level scalar fields on ReleaseMetadata (string | null), e.g.
 *   'intakePageId', 'fixVersion', 'envMatrixPrUrl'.
 * - Nested branches paths, e.g. 'branches.cdbUi', 'branches.cdbUiConfigs'.
 *
 * Both halves are derived from the model so renaming a field flags every
 * registration that referenced it. If the model gains another nested object
 * worth referencing (e.g. metadata.contacts), extend this union.
 */
type ScalarKey = {
  [K in keyof ReleaseMetadata]: ReleaseMetadata[K] extends string | null ? K : never;
}[keyof ReleaseMetadata];

type BranchKey = keyof ReleaseMetadata['branches'];

type FieldPath = ScalarKey | `branches.${BranchKey}`;

// ============================================================================
// Definition shape — what STAGE_DEFINITIONS contains
// ============================================================================

interface SubStepDef {
  id: string;
  label: string;
  /** Check IDs that auto-tick this sub-step. Empty = manual-only. */
  autoTickedBy?: string[];
  /**
   * Names the metadata field this sub-step's inline input writes to.
   * Format matches FieldPath: top-level key (e.g. 'intakePageId') or
   * 'branches.{key}'. Omit for manual-only sub-steps with no input.
   */
  editableField?: FieldPath;
}

interface CheckDef {
  id: string;
  label: string;
  runner: CheckRunner;
}

interface StageDef {
  id: string;
  name: string;
  kind: StageKind;
  /** First stage opens 'ready'; others open 'locked' until dependsOn complete. */
  initialStatus: StageStatus;
  dependsOn: string[];
  /** Only for parallel stages — sequential stages they must close before. */
  blocks?: string[];
  subSteps: SubStepDef[];
  checks: CheckDef[];
}

// ============================================================================
// STAGE_DEFINITIONS — the workflow
// ============================================================================
//
// Read-only top-down summary of the entire release workflow. To change
// anything about a stage (sub-step, check, dependency), edit it here.
// ============================================================================

const STAGE_DEFINITIONS: StageDef[] = [
  {
    id: 'stage1-intake',
    name: 'Intake & Setup',
    kind: 'sequential',
    initialStatus: 'ready',                 // first stage starts ready, not locked
    dependsOn: [],
    subSteps: [
      { id: 'add-confluence-page-link',     label: 'Add Release Confluence page link',                autoTickedBy: ['check-confluence-page-resolves'], editableField: 'intakePageId' },
      { id: 'confirm-env-allocation',       label: 'Confirm env allocation (Self Serve link)',         autoTickedBy: ['check-self-serve-link-resolves'], editableField: 'intakeSheetUrl' },
      { id: 'create-fix-version',           label: 'Create Fix Version in JIRA',                       autoTickedBy: ['check-fix-version-exists'],       editableField: 'fixVersion' },
      { id: 'add-intake-checklist-page-id', label: 'Add Intake Checklist Page ID in Admin Portal',     autoTickedBy: ['check-intake-page-id-set'],       editableField: 'intakePageId' },
      { id: 'raise-env-matrix-pr',          label: 'Raise PR to onboard branch on Env Matrix',         autoTickedBy: ['check-env-matrix-pr'],            editableField: 'envMatrixPrUrl' },
    ],
    checks: [
      { id: 'check-confluence-page-resolves', label: 'Confluence API: validate Release page link resolves',   runner: confluencePageCheck({ field: 'intakePageId' }) },
      { id: 'check-self-serve-link-resolves', label: 'Confluence API: validate Self Serve env link resolves', runner: confluencePageCheck({ field: 'intakeSheetUrl', isUrl: true }) },
      { id: 'check-fix-version-exists',       label: 'JIRA API: confirm Fix Version exists',                  runner: jiraFixVersionCheck({ field: 'fixVersion' }) },
      { id: 'check-intake-page-id-set',       label: 'Internal: validate Checklist Page ID is set',           runner: valueIsSetCheck({ field: 'intakePageId' }) },
      { id: 'check-env-matrix-pr',            label: 'GitHub API: confirm Env Matrix onboarding PR exists',   runner: githubPrUrlCheck({ field: 'envMatrixPrUrl' }) },
    ],
  },

  {
    id: 'stage2-branching',
    name: 'Branching & Configs (T-14)',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage1-intake'],
    subSteps: [
      { id: 'create-cdb-ui-configs-branch', label: 'Create CDB UI Configs branch off master',         autoTickedBy: ['check-cdb-ui-configs-branch-exists'], editableField: 'branches.cdbUiConfigs' },
      { id: 'email-adms',                   label: 'Email ADMs/devs from Scope Intake' },
      { id: 'open-master-jira',             label: 'Open master JIRA "CDB UI Configs - RXX"' },
      { id: 'add-da-team-subtasks',         label: 'Add subtasks per DA team' },
      { id: 'run-configs-report',           label: 'Run CDB_Release_Configs_Report in QA Signoff env' },
    ],
    checks: [
      { id: 'check-cdb-ui-configs-branch-exists', label: 'GitHub API: CDB UI Configs branch exists', runner: githubBranchUrlCheck({ field: 'branches.cdbUiConfigs' }) },
    ],
  },

  {
    id: 'stage3-build-stabilization',
    name: 'Build Stabilization (T-7)',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage2-branching'],
    subSteps: [
      { id: 'coordinate-platform-qa-go-no-go', label: 'Coordinate with Platform QA on stable commit' },
      { id: 'disable-sealights-pr',            label: 'Disable Sealights via config PR' },
      { id: 'run-automated-build-pipeline',    label: 'Run Automated Build Pipeline post-toggle' },
      { id: 'confirm-clean-qa-builds',         label: 'Confirm clean QA deployment builds generated' },
    ],
    checks: [],
  },

  {
    id: 'stage4-mobile-build',
    name: 'Mobile Build & Distribution (T-5 to T-4)',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage3-build-stabilization'],
    subSteps: [
      { id: 'confirm-package-json-version',  label: 'Confirm package.json version (PROD 0/3/6, Blue 1/4/7, Green 2/5/8)' },
      { id: 'update-mobile-versions-table',  label: 'Update Mobile App Versions Table' },
      { id: 'run-blue-mobile-build',         label: 'Run CDB_PROD_Blue_Mobile_Build_Publish' },
      { id: 'run-green-mobile-build',        label: 'Run CDB_PROD_Green_Mobile_Build_Publish' },
      { id: 'run-prod-mobile-build',         label: 'Run CDB_PROD_Mobile_Build_Publish' },
      { id: 'upload-ios-pre-prod',           label: 'Upload iOS Pre-PROD → TestFlight' },
      { id: 'share-android-pre-prod-path',   label: 'Share Android Pre-PROD build path' },
      { id: 'distribute-prod-builds',        label: 'Distribute PROD Android + iOS builds' },
      { id: 'share-build-links',             label: 'Share Mobile App Build Links with Release Mgmt' },
    ],
    checks: [],
  },

  {
    id: 'stage5-war-promotion',
    name: 'WAR Promotion (T-4 to T-3)',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage4-mobile-build'],
    subSteps: [
      { id: 'promote-war-azure', label: 'Promote WAR via Azure pipeline (definitionId=8398)' },
    ],
    checks: [],
  },

  {
    id: 'stage6-doc-prep',
    name: 'Documentation Prep',
    kind: 'parallel',
    initialStatus: 'locked',
    dependsOn: ['stage3-build-stabilization'],
    blocks: ['stage7-pre-prod'],
    subSteps: [
      { id: 'draft-pre-prod-letter', label: 'Draft Pre-PROD delivery letter' },
      { id: 'draft-prod-letter',     label: 'Draft PROD delivery letter' },
      { id: 'close-jira-subtasks',   label: 'Close JIRA subtasks + master ticket for UI Configs' },
    ],
    checks: [],
  },

  {
    id: 'stage7-pre-prod',
    name: 'Pre-PROD Deployment',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage5-war-promotion', 'stage6-doc-prep'],
    subSteps: [
      { id: 'deploy-configs-wem',      label: 'Deploy configs to PROD WEM server' },
      { id: 'validate-3-4-passes',     label: 'Validate 3-4 passes' },
      { id: 'execute-tech-validation', label: 'Execute technical validation per CDB Release runbook' },
    ],
    checks: [],
  },

  {
    id: 'stage8-prod',
    name: 'PROD Deployment',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage7-pre-prod'],
    subSteps: [
      { id: 'repeat-config-war-verification', label: 'Repeat config/WAR verification' },
      { id: 'execute-tech-validation-prod',   label: 'Execute technical validation' },
      { id: 'coordinate-traffic-switch',      label: 'Coordinate traffic switch per PROD delivery letter' },
    ],
    checks: [],
  },

  {
    id: 'stage9-post-go-live',
    name: 'Post-Go-Live',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage8-prod'],
    subSteps: [
      { id: 'update-f26-deployments-page', label: 'Update build versions on F26 Deployments page' },
      { id: 'retrofit-cdb-ui-branch',      label: 'Retrofit CDB UI release branch → master' },
      { id: 'retrofit-cdb-configs-branch', label: 'Retrofit CDB Configs release branch → master' },
      { id: 'retrofit-freddy-branch',      label: 'Retrofit Freddy release branch → master' },
      { id: 'tag-repos',                   label: 'Tag repos (CDB, CDB_configs, Freddy)' },
    ],
    checks: [],
  },

  {
    id: 'stage10-post-mobile',
    name: 'Post Mobile App Release',
    kind: 'sequential',
    initialStatus: 'locked',
    dependsOn: ['stage9-post-go-live'],
    subSteps: [
      { id: 'upload-prod-dsym-firebase', label: 'Upload PROD dSYM files to Firebase Console' },
    ],
    checks: [],
  },
];

// ============================================================================
// Pattern factories — the reusable check library
//
// Each factory takes a small config and returns a CheckRunner. They live
// below STAGE_DEFINITIONS because the definitions reference them by name —
// JavaScript hoists function declarations so this works.
// ============================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function pass(check: AutomatedCheck, result: Record<string, unknown>): AutomatedCheck {
  return { ...check, status: 'passed', lastRunAt: nowIso(), result, errorMessage: null };
}

function fail(check: AutomatedCheck, message: string): AutomatedCheck {
  return { ...check, status: 'failed', lastRunAt: nowIso(), result: null, errorMessage: message };
}

/**
 * Read the value at `path` on a release's metadata.
 *
 * Supports either a top-level scalar field ('intakePageId') or a single-level
 * nested path under branches ('branches.cdbUi'). Returns null if anything in
 * the chain is missing.
 */
function readField(release: Release, path: FieldPath): string | null {
  if (path.startsWith('branches.')) {
    const branchKey = path.slice('branches.'.length) as BranchKey;
    return release.metadata.branches?.[branchKey] ?? null;
  }
  return release.metadata[path as ScalarKey] ?? null;
}

function parseConfluencePageIdFromUrl(url: string): string | null {
  const pages = url.match(/\/pages\/(\d+)(?:\/|$)/);
  if (pages) return pages[1];
  const query = url.match(/[?&]pageId=(\d+)/);
  if (query) return query[1];
  return null;
}

function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const num = parseInt(m[3], 10);
  if (!Number.isFinite(num)) return null;
  return { owner: m[1], repo: m[2], number: num };
}

function parseGithubBranchUrl(url: string): { owner: string; repo: string; branch: string } | null {
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/tree\/([^?#]+?)\/?(?:[?#]|$)/);
  if (!m) return null;
  const branch = m[3];
  if (!branch) return null;
  return { owner: m[1], repo: m[2], branch };
}

/**
 * Pass if the configured field holds a Confluence page ID (or URL with
 * `isUrl: true`) that resolves.
 */
export function confluencePageCheck(config: { field: FieldPath; isUrl?: boolean }): CheckRunner {
  const { field, isUrl } = config;
  return async (release, check) => {
    const raw = readField(release, field);
    if (!raw || !raw.trim()) return fail(check, `${field} is not set on this release`);

    const pageId = isUrl ? parseConfluencePageIdFromUrl(raw) : raw;
    if (!pageId) return fail(check, `Could not parse pageId from ${field}: ${raw}`);

    try {
      const page: any = await confluenceService.getPageContent(pageId);
      if (!page || !page.id) return fail(check, `Confluence page '${pageId}' not found`);
      return pass(check, {
        pageId: page.id,
        title: page.title ?? '(untitled)',
        webui: page._links?.webui ?? null,
      });
    } catch (err: any) {
      const msg = err?.response?.status === 404
        ? `Confluence page '${pageId}' not found (404)`
        : (err?.message ?? 'Confluence API call failed');
      return fail(check, msg);
    }
  };
}

/**
 * Pass if the configured field holds a GitHub PR URL that resolves to a real PR.
 */
export function githubPrUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const url = readField(release, field);
    if (!url || !url.trim()) return fail(check, `${field} is not set on this release`);

    const parsed = parseGithubPrUrl(url);
    if (!parsed) return fail(check, `Could not parse owner/repo/number from PR URL: ${url}`);

    try {
      const pr: any = await githubService.getPullRequest(parsed.owner, parsed.repo, parsed.number);
      if (!pr || !pr.number) return fail(check, `GitHub PR not found: ${parsed.owner}/${parsed.repo}#${parsed.number}`);
      return pass(check, {
        prNumber: pr.number,
        title: pr.title ?? null,
        state: pr.merged_at ? 'merged' : (pr.state ?? null),
        url: pr.html_url ?? url,
      });
    } catch (err: any) {
      return fail(check, err?.message ?? 'GitHub API call failed');
    }
  };
}

/**
 * Pass if the configured field holds a GitHub branch URL (in /tree/ form)
 * that resolves to a real branch.
 */
export function githubBranchUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const url = readField(release, field);
    if (!url || !url.trim()) return fail(check, `${field} is not set on this release`);

    const parsed = parseGithubBranchUrl(url);
    if (!parsed) return fail(check, `Could not parse owner/repo/branch from URL: ${url}`);

    try {
      const branch: any = await githubService.getBranch(parsed.owner, parsed.repo, parsed.branch);
      if (!branch || !branch.name) return fail(check, `GitHub branch not found: ${parsed.owner}/${parsed.repo}@${parsed.branch}`);
      return pass(check, {
        branchName: branch.name,
        owner: parsed.owner,
        repo: parsed.repo,
        sha: branch.commit?.sha ?? null,
      });
    } catch (err: any) {
      return fail(check, err?.message ?? 'GitHub API call failed');
    }
  };
}

/**
 * Pass if the configured JIRA fix version exists in the configured project.
 */
export function jiraFixVersionCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const versionName = readField(release, field);
    if (!versionName || !versionName.trim()) return fail(check, `${field} is not set on this release`);

    try {
      const version: any = await jiraService.getFixVersionByName(versionName);
      if (!version || !version.id) return fail(check, `JIRA Fix Version '${versionName}' not found`);
      return pass(check, {
        id: version.id,
        name: version.name ?? versionName,
        projectKey: version.projectKey ?? null,
        released: version.released ?? null,
      });
    } catch (err: any) {
      const msg = err?.response?.status === 404
        ? `JIRA Fix Version '${versionName}' not found (404)`
        : (err?.message ?? 'JIRA API call failed');
      return fail(check, msg);
    }
  };
}

/**
 * Pure local check: pass if the configured metadata field is non-empty.
 */
export function valueIsSetCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const value = readField(release, field);
    return value && value.trim()
      ? pass(check, { [field]: value })
      : fail(check, `${field} is not set on this release`);
  };
}

// ============================================================================
// Derived exports — STAGE_TEMPLATE and STAGE_RUNNERS
//
// The service consumes these. Both are derived from STAGE_DEFINITIONS so
// they can never drift out of sync.
// ============================================================================

/**
 * The canonical 10-stage structure used to seed every new release.
 * Built from STAGE_DEFINITIONS at module load.
 */
export const STAGE_TEMPLATE: Stage[] = STAGE_DEFINITIONS.map((def, idx) => ({
  id: def.id,
  displayOrder: idx + 1,
  name: def.name,
  kind: def.kind,
  status: def.initialStatus,
  startedAt: null,
  closedAt: null,
  subSteps: def.subSteps.map((s) => ({
    id: s.id,
    label: s.label,
    state: 'unchecked' as const,
    source: null,
    autoTickedBy: s.autoTickedBy ?? [],
    editableField: s.editableField ?? null,
    completedAt: null,
    completedBy: null,
  })),
  automatedChecks: def.checks.map((c) => ({
    id: c.id,
    label: c.label,
    status: 'pending' as const,
    lastRunAt: null,
    result: null,
    errorMessage: null,
  })),
  notes: [],
  override: null,
  dependsOn: def.dependsOn,
  ...(def.blocks ? { blocks: def.blocks } : {}),
}));

/**
 * Per-stage map of check ID → runner function. Built from STAGE_DEFINITIONS
 * at module load. Stages with no checks get an empty map (which the service
 * treats the same as "no runners registered").
 */
export const STAGE_RUNNERS: Record<string, StageRunnerMap> = Object.fromEntries(
  STAGE_DEFINITIONS.map((def) => [
    def.id,
    Object.fromEntries(def.checks.map((c) => [c.id, c.runner])) as StageRunnerMap,
  ]),
);

/**
 * Returns a deep clone of STAGE_TEMPLATE so each new release gets a fresh,
 * independent copy. JSON round-trip is safe because the template contains
 * only JSON-serialisable values.
 */
export function cloneStageTemplate(): Stage[] {
  return JSON.parse(JSON.stringify(STAGE_TEMPLATE));
}

/**
 * For a given metadata field path, returns the IDs of stages whose sub-steps
 * declare that field as their `editableField`. Used by the metadata-patch
 * endpoint to figure out which stages need their checks re-run after a field
 * is updated.
 *
 * A field can drive checks in multiple stages (e.g. if Stage 1 and Stage 4
 * both reference the same field), so this returns an array.
 */
export function stagesUsingField(field: string): string[] {
  const stages = new Set<string>();
  for (const def of STAGE_DEFINITIONS) {
    if (def.subSteps.some((s) => s.editableField === field)) {
      stages.add(def.id);
    }
  }
  return [...stages];
}
