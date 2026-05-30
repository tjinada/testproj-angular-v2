
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
  autoTickedBy: string[];        // check IDs that auto-tick this sub-step; [] for manual-only
  editableField: string | null;
  inputType: 'text' | 'textarea';
  track: SubStepTrack;
  placeholder: string | null;
  helpUrl: string | null;
  helpUrlLabel: string | null;
  completedAt: string | null;
  completedBy: string | null;    // username, or "system" for auto-ticks
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

// ===== stage =====

export interface Stage {
  id: string;                    //ex: "stage4-mobile-build"
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
  cdbUiConfigJiraUrl: string | null;
  sealightsDisablePrUrl: string | null; 
  preProdLetterUrl: string | null;
  prodLetterUrl: string | null;
  retrofitCdbUiPrUrl: string | null;
  retrofitCdbConfigsPrUrl: string | null;
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
  tagCdbbosUrl: string | null;
  tagCdbbosConfigUrl: string | null;
  dependencyJarBranchUrls: string | null;
  cdbUiArtifactPath: string | null;
  cdbbosEarArtifactPath: string | null;
  cdbbosConfigArtifactPath: string | null;
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
  backupSheriff: string | null;
  releaseComponents: ReleaseComponents;
  createdAt: string;
  updatedAt: string;
  metadata: ReleaseMetadata;
  stages: Stage[];               // always 10 entries, ordered by displayOrder
}

export type ReleaseWorkflowData = Record<string, Release>;