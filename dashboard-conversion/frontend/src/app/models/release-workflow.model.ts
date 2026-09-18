/**
 * Release Workflow — shared model (frontend)
 *
 * Mirrors backend/src/models/release-workflow.model.ts exactly.
 * Keep these two files in sync.
 */

export type ReleaseType   = 'bundle' | 'independent' | 'hotfix';
export type ReleaseStatus = 'not_started' | 'in_progress' | 'blocked' | 'complete' | 'aborted';
export type StageKind     = 'sequential' | 'parallel';
export type StageStatus   = 'locked' | 'ready' | 'in_progress' | 'complete' | 'skipped';
export type SubStepState  = 'unchecked' | 'checked' | 'n_a';
export type SubStepSource = 'manual' | 'auto' | null;
export type CheckStatus   = 'pending' | 'running' | 'passed' | 'failed' | 'partial';
export type SubStepTrack  = 'generic' | 'cdbui' | 'cdbbos';

export interface ReleaseComponents {
  cdbui: boolean;
  cdbbos: boolean;
}

export interface SubStep {
  id: string;
  label: string;
  state: SubStepState;
  source: SubStepSource;
  autoTickedBy: string[];
  editableField: string | null;
  inputType: 'text' | 'textarea';
  track: SubStepTrack;
  placeholder: string | null;
  helpUrl: string | null;
  helpUrlLabel: string | null;
  completedAt: string | null;
  completedBy: string | null;
}

export interface AutomatedCheck {
  id: string;
  label: string;
  status: CheckStatus;
  lastRunAt: string | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface Note {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  isBlocker: boolean;
}

export interface Override {
  reason: string;
  overriddenBy: string;
  overriddenAt: string;
}

/**
 * Set when a release is closed early. Non-null means the release is latched
 * read-only and its status is 'aborted'.
 */
export interface ReleaseClosure {
  comment: string;
  closedBy: string;
  closedAt: string;
}

export interface Stage {
  id: string;
  displayOrder: number;
  name: string;
  kind: StageKind;
  status: StageStatus;
  startedAt: string | null;
  closedAt: string | null;
  subSteps: SubStep[];
  automatedChecks: AutomatedCheck[];
  notes: Note[];
  override: Override | null;
  dependsOn: string[];
  blocks?: string[];
}

export interface ReleaseMetadata {
  preProdDate: string | null;
  prodDate: string | null;
  jiraTracker: string | null;
  intakePageUrl: string | null;
  intakeSheetUrl: string | null;
  confluencePageId: string | null;
  fixVersion: string | null;
  envMatrixPrUrl: string | null;
  cdbUiConfigJiraUrl: string | null;
  cdbUiSwaggerBranchUrl: string | null;
  sealightsDisablePrUrl: string | null;
  preProdLetterUrl: string | null;
  prodLetterUrl: string | null;
  earlyRetrofitCdbUiPrUrl: string | null;
  earlyRetrofitCdbUiConfigPrUrl: string | null;
  earlyRetrofitCdbbosPrUrl: string | null;
  earlyRetrofitCdbbosConfigPrUrl: string | null;
  retrofitCdbUiPrUrl: string | null;
  retrofitCdbConfigsPrUrl: string | null;
  retrofitCdbUiSwaggerPrUrl: string | null;
  retrofitFreddyPrUrl: string | null;
  tagCdbUiUrl: string | null;
  tagCdbConfigsUrl: string | null;
  tagFreddyUrl: string | null;
  cdbbosConfigBranchUrl: string | null;
  cdbbosReleaseBranchUrl: string | null;
  cdbSwaggerBranchUrl: string | null;
  cdbbosJiraUrl: string | null;
  retrofitCdbbosPrUrl: string | null;
  retrofitCdbbosConfigPrUrl: string | null;
  retrofitCdbbosSwaggerPrUrl: string | null;
  tagCdbbosUrl: string | null;
  tagCdbbosConfigUrl: string | null;
  dependencyJarBranchUrls: string | null;
  cdbUiArtifactPath: string | null;
  cdbbosEarArtifactPath: string | null;
  cdbbosConfigSccArtifactPath: string | null;
  cdbbosConfigBccArtifactPath: string | null;
  branches: {
    cdbUi: string | null;
    cdbUiConfigs: string | null;
    freddy: string | null;
  };
}

export interface Release {
  releaseId: string;
  title: string;
  type: ReleaseType;
  status: ReleaseStatus;
  uiSheriff: string | null;
  uiBackupSheriff: string | null;
  bosSheriff: string | null;
  bosBackupSheriff: string | null;
  releaseComponents: ReleaseComponents;
  createdAt: string;
  updatedAt: string;
  metadata: ReleaseMetadata;
  closure: ReleaseClosure | null;
  stages: Stage[];
}

export interface CreateReleaseInput {
  releaseId: string;
  title: string;
  type: ReleaseType;
  uiSheriff?: string | null;
  uiBackupSheriff?: string | null;
  bosSheriff?: string | null;
  bosBackupSheriff?: string | null;
  releaseComponents: ReleaseComponents;
  metadata?: Partial<ReleaseMetadata>;
}