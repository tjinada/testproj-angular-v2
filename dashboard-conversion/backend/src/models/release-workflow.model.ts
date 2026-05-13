/**
 * Release Workflow — shared model
 *
 * All types for the release workflow feature live in this one file.
 * Frontend mirrors this file at frontend/src/app/pages/admin/models/release-workflow.model.ts
 *
 * Top-level persisted shape (in /release_workflow_data.json):
 *   Record<releaseId, Release>
 */

// ===== type unions =====

export type ReleaseType   = 'bundle' | 'independent' | 'hotfix';
export type ReleaseStatus = 'not_started' | 'in_progress' | 'blocked' | 'complete' | 'aborted';
export type StageKind     = 'sequential' | 'parallel';
export type StageStatus   = 'locked' | 'ready' | 'in_progress' | 'complete' | 'skipped';
export type SubStepState  = 'unchecked' | 'checked' | 'n_a';
export type SubStepSource = 'manual' | 'auto' | null;
export type CheckStatus   = 'pending' | 'running' | 'passed' | 'failed' | 'partial';

// ===== leaf shapes =====

export interface SubStep {
  id: string;                    // stable slug, scoped to its stage
  label: string;
  state: SubStepState;
  source: SubStepSource;
  autoTickedBy: string[];        // check IDs that auto-tick this sub-step; [] for manual-only
  /**
   * If set, names the metadata field this sub-step's inline input writes to.
   * Format: 'fieldName' for top-level fields, or 'branches.fieldName' for
   * nested branch fields. Null for manual-only sub-steps with no input.
   */
  editableField: string | null;
  /**
   * Placeholder text shown in the inline edit input. Null = use the
   * default placeholder for the sub-step's runner (or a generic one if
   * there's no runner). Set explicitly in YAML to override.
   */
  placeholder: string | null;
  completedAt: string | null;    // ISO 8601
  completedBy: string | null;    // username, or "system" for auto-ticks
}

export interface AutomatedCheck {
  id: string;
  label: string;
  status: CheckStatus;
  lastRunAt: string | null;
  result: Record<string, unknown> | null;  // free-form, per-stage code defines shape
  errorMessage: string | null;
}

export interface Note {
  id: string;
  author: string;
  createdAt: string;             // ISO 8601
  body: string;
  isBlocker: boolean;
}

export interface Override {
  reason: string;
  overriddenBy: string;
  overriddenAt: string;          // ISO 8601
}

// ===== stage =====

export interface Stage {
  id: string;                    // stable slug, e.g. "stage4-mobile-build"
  displayOrder: number;          // 1-10
  name: string;                  // without "Stage N — " prefix
  kind: StageKind;
  status: StageStatus;
  startedAt: string | null;
  closedAt: string | null;
  subSteps: SubStep[];
  automatedChecks: AutomatedCheck[];
  notes: Note[];
  override: Override | null;
  dependsOn: string[];           // stage IDs that must close before this can start
  blocks?: string[];             // only on parallel stages — sequential stages they must close before
}

// ===== release =====

export interface ReleaseMetadata {
  preProdDate: string | null;
  prodDate: string | null;
  jiraTracker: string | null;
  intakePageId: string | null;
  intakeSheetUrl: string | null;
  confluencePageId: string | null;
  fixVersion: string | null;
  envMatrixPrUrl: string | null;
  cdbUiConfigJiraUrl: string | null;   // Stage 2: master JIRA ticket for the CDB UI Configs branch work
  sealightsDisablePrUrl: string | null;   // Stage 3: PR that disables Sealights via config
  branches: {
    cdbUi: string | null;
    cdbUiConfigs: string | null;
    freddy: string | null;
  };
}

export interface Release {
  releaseId: string;             // matches the top-level Record key
  title: string;
  type: ReleaseType;
  status: ReleaseStatus;
  sheriff: string;
  createdAt: string;
  updatedAt: string;
  metadata: ReleaseMetadata;
  stages: Stage[];               // always 10 entries, ordered by displayOrder
}

// ===== persisted shape =====

export type ReleaseWorkflowData = Record<string, Release>;
