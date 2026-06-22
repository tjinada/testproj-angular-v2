import artifactoryService from './artifactory.service';
import techGovernanceReleasesIntakeService from './tech-governance-releases-intake.service';
import {
  cloneStageTemplate,
  STAGE_TEMPLATE,
  STAGE_RUNNERS,
  StageRunnerMap,
  stagesUsingField,
} from './release-workflow.loader';
import { parseConfluencePageIdFromUrl } from './release-workflow.runners';
import {
  Release,
  ReleaseComponents,
  ReleaseMetadata,
  ReleaseType,
  ReleaseWorkflowData,
  Stage,
  SubStep,
  SubStepState,
  SubStepSource,
  AutomatedCheck,
} from '../models/release-workflow.model';

class ReleaseWorkflowService {
  private readonly earlyRetrofitReleaseStageId = 'stage3-early-retrofit-release';
  private readonly dataFileName = 'release_workflow_data.json';

  constructor() {
    this.initialize();
  }

  async initialize(): Promise<void> {
    // Reconcile every existing release against the current STAGE_TEMPLATE.
    await this.reconcileWithTemplate();
  }

  /** Load the latest releases from Artifactory. Returns {} when the file doesn't exist yet. */
  private async load(): Promise<ReleaseWorkflowData> {
    try {
      const data = await artifactoryService.getFileContent(this.dataFileName);
      const releases: ReleaseWorkflowData = { ...data };
      this.normalizeLegacyReleaseTypes(releases);
      return releases;
    } catch (error) {
      console.log('No existing release_workflow_data found in artifactory');
      // Expected error when file doesn't exist
      return {};
    }
  }

  private async save(releases: ReleaseWorkflowData): Promise<void> {
    await artifactoryService.saveFileContent(this.dataFileName, releases);
  }

  /** Returns the latest releases keyed by releaseId. */
  async getAll(): Promise<ReleaseWorkflowData> {
    return this.load();
  }

  /** Returns a single release by ID, or undefined if not found. */
  async getById(releaseId: string): Promise<Release | undefined> {
    return (await this.load())[releaseId];
  }

  private assertBundleReleaseCanSkip(release: Release, stage: Stage, action: 'sub-step' | 'stage'): void {
    if (stage.id === this.earlyRetrofitReleaseStageId) return;
    if (release.type !== 'bundle') return;
    throw new Error(`Bundle releases cannot be skipped at the ${action} level`);
  }

  private normalizeLegacyReleaseTypes(releases: ReleaseWorkflowData): void {
    for (const release of Object.values(releases)) {
      if ((release.type as string) === 'EQF/hotfix') {
        release.type = 'hotfix';
      }
    }
  }

  // ----- create -----

  /**
   * Add a new release. Clones the stage template and seeds metadata.
   */
  async add(input: {
    releaseId: string;
    title: string;
    type: ReleaseType;
    uiSheriff?: string | null;
    uiBackupSheriff?: string | null;
    bosSheriff?: string | null;
    bosBackupSheriff?: string | null;
    releaseComponents?: Partial<ReleaseComponents>;
    metadata?: Partial<ReleaseMetadata>;
  }): Promise<Release> {
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
    } = input;

    if (!releaseId || typeof releaseId !== 'string') {
      throw new Error('releaseId is required');
    }
    const releases = await this.load();
    if (releases[releaseId]) {
      throw new Error(`Release '${releaseId}' already exists`);
    }

    const now = new Date().toISOString();
    const normalizedReleaseComponents = normalizeReleaseComponents(releaseComponents);
    const sheriffFields = buildSheriffAssignments({
      releaseComponents: normalizedReleaseComponents,
      uiSheriff,
      uiBackupSheriff,
      bosSheriff,
      bosBackupSheriff,
    });

    const release: Release = {
      releaseId,
      title,
      type,
      status: 'in_progress',   // newly-created releases open in-progress on Stage 1
      uiSheriff: sheriffFields.uiSheriff,
      uiBackupSheriff: sheriffFields.uiBackupSheriff,
      bosSheriff: sheriffFields.bosSheriff,
      bosBackupSheriff: sheriffFields.bosBackupSheriff,
      releaseComponents: normalizedReleaseComponents,
      createdAt: now,
      updatedAt: now,
      metadata: this.buildMetadata(metadata),
      stages: cloneStageTemplate(),
    };

    // mark Stage 1 as started
    const stage1 = release.stages.find((s) => s.id === 'stage1-intake');
    if (stage1) {
      stage1.startedAt = now;
    }

    this.recomputeStatuses(release);

    releases[releaseId] = release;
    await this.save(releases);

    // Create a corresponding release in the tech governance source.
    try {
      await techGovernanceReleasesIntakeService.addEmptyRelease(this.toGovernanceKey(releaseId), title);
    } catch (err: any) {
      console.error(
        `[release-workflow] Failed to create tech governance entry for '${releaseId}':`,
        err?.message ?? err,
      );
    }

    return release;
  }

  /**
   * Update top-level release metadata (title, component sheriffs, dates, etc).
   */
  async update(
    releaseId: string,
    patch: Partial<Pick<Release, 'title' | 'uiSheriff' | 'uiBackupSheriff' | 'bosSheriff' | 'bosBackupSheriff' | 'metadata' | 'status'>> & {
      releaseComponents?: Partial<ReleaseComponents>;
    },
  ): Promise<Release> {
    const releases = await this.load();
    const existing = releases[releaseId];
    if (!existing) {
      throw new Error(`Release '${releaseId}' not found`);
    }

    const normalizedReleaseComponents = patch.releaseComponents
      ? normalizeReleaseComponents({
          ...normalizeReleaseComponents(existing.releaseComponents),
          ...patch.releaseComponents,
        })
      : normalizeReleaseComponents(existing.releaseComponents);
    const sheriffFields = buildSheriffAssignments({
      releaseComponents: normalizedReleaseComponents,
      uiSheriff: patch.uiSheriff,
      uiBackupSheriff: patch.uiBackupSheriff,
      bosSheriff: patch.bosSheriff,
      bosBackupSheriff: patch.bosBackupSheriff,
      existing,
    });

    const updated: Release = {
      ...existing,
      title: patch.title ?? existing.title,
      uiSheriff: sheriffFields.uiSheriff,
      uiBackupSheriff: sheriffFields.uiBackupSheriff,
      bosSheriff: sheriffFields.bosSheriff,
      bosBackupSheriff: sheriffFields.bosBackupSheriff,
      status: patch.status ?? existing.status,
      releaseComponents: normalizedReleaseComponents,
      metadata: patch.metadata ? { ...existing.metadata, ...patch.metadata } : existing.metadata,
      updatedAt: new Date().toISOString(),
    };

    this.recomputeStatuses(updated);

    releases[releaseId] = updated;
    await this.save(releases);
    return updated;
  }

  /**
   * Toggle a sub-step's state. Persists the new state, source, completedAt,
   * and completedBy fields.
   */
  async updateSubStep(
    releaseId: string,
    stageId: string,
    subStepId: string,
    patch: { state: SubStepState; source: SubStepSource; actor?: string },
  ): Promise<SubStep> {
    const releases = await this.load();
    const release = releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);

    if (patch.state === 'n_a') {
      this.assertBundleReleaseCanSkip(release, stage, 'sub-step');
    }

    const subStep = stage.subSteps.find((s) => s.id === subStepId);
    if (!subStep) throw new Error(`Sub-step '${subStepId}' not found in stage '${stageId}'`);

    const now = new Date().toISOString();
    subStep.state = patch.state;
    subStep.source = patch.state === 'unchecked' ? null : patch.source;
    subStep.completedAt = patch.state === 'unchecked' ? null : now;
    subStep.completedBy = patch.state === 'unchecked' ? null : (patch.actor ?? 'unknown');

    this.recomputeStatuses(release);

    release.updatedAt = now;
    await this.save(releases);
    return subStep;
  }

  async setStageNa(
    releaseId: string,
    stageId: string,
    na: boolean,
    actor?: string,
  ): Promise<Stage> {
    const releases = await this.load();
    const release = releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);
    if (na) {
      this.assertBundleReleaseCanSkip(release, stage, 'stage');
    }
    if (stage.status === 'complete') {
      throw new Error(`Completed stage '${stageId}' cannot be updated with stage-level N/A`);
    }

    const applicableSubSteps = this.applicableSubSteps(release, stage);
    const now = new Date().toISOString();
    const editableFieldsToClear = new Set<string>();
    const linkedCheckIdsToReset = new Set<string>();

    for (const subStep of applicableSubSteps) {
      if (na) {
        subStep.state = 'n_a';
        subStep.source = 'manual';
        subStep.completedAt = now;
        subStep.completedBy = actor ?? 'unknown';
      } else {
        subStep.state = 'unchecked';
        subStep.source = null;
        subStep.completedAt = null;
        subStep.completedBy = null;
        if (subStep.editableField) {
          editableFieldsToClear.add(subStep.editableField);
        }
        for (const checkId of subStep.autoTickedBy) {
          linkedCheckIdsToReset.add(checkId);
        }
      }
    }

    if (!na) {
      for (const field of editableFieldsToClear) {
        this.setMetadataFieldValue(release, field, null);
      }
      for (const check of stage.automatedChecks) {
        if (!linkedCheckIdsToReset.has(check.id)) continue;
        check.status = 'pending';
        check.lastRunAt = null;
        check.result = null;
        check.errorMessage = null;
      }
    }

    this.recomputeStatuses(release);

    release.updatedAt = now;
    await this.save(releases);
    return stage;
  }

  private setMetadataFieldValue(release: Release, field: string, value: string | null): void {
    if (field.startsWith('branches.')) {
      const branchKey = field.slice('branches.'.length) as keyof ReleaseMetadata['branches'];
      if (!(branchKey in release.metadata.branches)) {
        throw new Error(`Unknown branches field: ${field}`);
      }
      release.metadata.branches[branchKey] = value;
      return;
    }

    if (!(field in release.metadata) || field === 'branches') {
      throw new Error(`Unknown metadata field: ${field}`);
    }

    (release.metadata as any)[field] = value;
  }

  /**
   * Trigger automated checks for a stage. Loads the release, runs the checks
   * in memory, and persists once.
   */
  async runChecks(
    releaseId: string,
    stageId: string,
    actor?: string,
    specificCheckIds?: string[],
  ): Promise<AutomatedCheck[]> {
    const releases = await this.load();
    const release = releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);

    const changed = await this.runChecksInMemory(release, stageId, actor, specificCheckIds);
    if (changed) {
      await this.save(releases);
    }
    return stage.automatedChecks;
  }

  /**
   * Run the applicable checks for a stage against an already-loaded release
   */
  private async runChecksInMemory(
    release: Release,
    stageId: string,
    actor?: string,
    specificCheckIds?: string[],
  ): Promise<boolean> {
    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${release.releaseId}'`);

    const runners = this.getRunnersForStage(stageId);
    if (!runners) {
      // No runners registered for this stage yet — nothing to run.
      return false;
    }

    const applicableCheckIds = new Set(
      this.applicableSubSteps(release, stage).flatMap((subStep) => subStep.autoTickedBy),
    );
    if (applicableCheckIds.size === 0) {
      return false;
    }

    let checkIdsToRun = applicableCheckIds;
    if (specificCheckIds && specificCheckIds.length > 0) {
      const requestedCheckIds = new Set(specificCheckIds);
      checkIdsToRun = new Set([...applicableCheckIds].filter((id) => requestedCheckIds.has(id)));
    }
    if (checkIdsToRun.size === 0) {
      return false;
    }

    // Run all checks in parallel; failures inside one check don't fail the whole batch.
    const updated = await Promise.all(
      stage.automatedChecks.map(async (check) => {
        if (!checkIdsToRun.has(check.id)) return check;
        const runner = runners[check.id];
        if (!runner) return check;
        try {
          return await runner(release, check);
        } catch (err: any) {
          return {
            ...check,
            status: 'failed' as const,
            lastRunAt: new Date().toISOString(),
            result: null,
            errorMessage: err?.message ?? 'Unexpected error running check',
          };
        }
      }),
    );

    // Write results back into the stage and auto-tick linked sub-steps.
    stage.automatedChecks = updated;
    this.applyAutoTicks(release, stage, updated, actor);

    this.recomputeStatuses(release);

    release.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Returns the check-runner map for the given stage, or null if no
   * runners are registered for that stage yet.
   */
  private getRunnersForStage(stageId: string): StageRunnerMap | null {
    return STAGE_RUNNERS[stageId] ?? null;
  }

  /**
   * Reconcile sub-step ticks with the latest check results.
   */
  private applyAutoTicks(release: Release, stage: Stage, checks: AutomatedCheck[], actor?: string): void {
    const now = new Date().toISOString();
    const checkById = new Map(checks.map((c) => [c.id, c]));

    for (const subStep of this.applicableSubSteps(release, stage)) {
      if (subStep.autoTickedBy.length === 0) continue;     // purely manual sub-step
      if (subStep.state === 'n_a') continue;               // sticky
      if (subStep.state === 'checked' && subStep.source === 'manual') continue;  // sticky

      const linked = subStep.autoTickedBy
        .map((id) => checkById.get(id))
        .filter((c): c is AutomatedCheck => !!c);

      if (linked.length === 0) continue;                   // nothing to evaluate

      const allPassed = linked.every((c) => c.status === 'passed');
      const anyFailed = linked.some((c) => c.status === 'failed');

      if (allPassed) {
        // (re-)tick from auto. No-op if already in this state.
        if (subStep.state !== 'checked' || subStep.source !== 'auto') {
          subStep.state = 'checked';
          subStep.source = 'auto';
          subStep.completedAt = now;
          subStep.completedBy = actor ?? 'system';
        }
      } else if (anyFailed) {
        // un-tick — but only if it was auto-ticked. Manual was filtered above.
        if (subStep.state === 'checked' && subStep.source === 'auto') {
          subStep.state = 'unchecked';
          subStep.source = null;
          subStep.completedAt = null;
          subStep.completedBy = null;
        }
      }
      // else: partial / pending / running mix — leave whatever state we have
    }
  }

  // ----- delete -----

  async delete(releaseId: string): Promise<boolean> {
    const releases = await this.load();
    if (!releases[releaseId]) return false;
    delete releases[releaseId];
    await this.save(releases);
    return true;
  }

  private toGovernanceKey(releaseId: string): string {
    const bare = releaseId.trim().toLowerCase().replace(/^release\//, '');
    return `release/${bare}`;
  }
  
  private buildMetadata(input?: Partial<ReleaseMetadata>): ReleaseMetadata {
    return {
      preProdDate: input?.preProdDate ?? null,
      prodDate: input?.prodDate ?? null,
      jiraTracker: input?.jiraTracker ?? null,
      intakePageUrl: input?.intakePageUrl ?? null,
      intakeSheetUrl: input?.intakeSheetUrl ?? null,
      confluencePageId: input?.confluencePageId ?? null,
      fixVersion: input?.fixVersion ?? null,
      envMatrixPrUrl: input?.envMatrixPrUrl ?? null,
      cdbUiConfigJiraUrl: input?.cdbUiConfigJiraUrl ?? null,
      cdbUiSwaggerBranchUrl: input?.cdbUiSwaggerBranchUrl ?? null,
      sealightsDisablePrUrl: input?.sealightsDisablePrUrl ?? null,
      preProdLetterUrl: input?.preProdLetterUrl ?? null,
      prodLetterUrl: input?.prodLetterUrl ?? null,
      earlyRetrofitCdbUiPrUrl: input?.earlyRetrofitCdbUiPrUrl ?? null,
      earlyRetrofitCdbUiConfigPrUrl: input?.earlyRetrofitCdbUiConfigPrUrl ?? null,
      earlyRetrofitCdbbosPrUrl: input?.earlyRetrofitCdbbosPrUrl ?? null,
      earlyRetrofitCdbbosConfigPrUrl: input?.earlyRetrofitCdbbosConfigPrUrl ?? null,
      retrofitCdbUiPrUrl: input?.retrofitCdbUiPrUrl ?? null,
      retrofitCdbConfigsPrUrl: input?.retrofitCdbConfigsPrUrl ?? null,
      retrofitCdbUiSwaggerPrUrl: input?.retrofitCdbUiSwaggerPrUrl ?? null,
      retrofitFreddyPrUrl: input?.retrofitFreddyPrUrl ?? null,
      tagCdbUiUrl: input?.tagCdbUiUrl ?? null,
      tagCdbConfigsUrl: input?.tagCdbConfigsUrl ?? null,
      tagFreddyUrl: input?.tagFreddyUrl ?? null,
      cdbbosConfigBranchUrl: input?.cdbbosConfigBranchUrl ?? null,
      cdbbosReleaseBranchUrl: input?.cdbbosReleaseBranchUrl ?? null,
      cdbSwaggerBranchUrl: input?.cdbSwaggerBranchUrl ?? null,
      cdbbosJiraUrl: input?.cdbbosJiraUrl ?? null,
      retrofitCdbbosPrUrl: input?.retrofitCdbbosPrUrl ?? null,
      retrofitCdbbosConfigPrUrl: input?.retrofitCdbbosConfigPrUrl ?? null,
      retrofitCdbbosSwaggerPrUrl: input?.retrofitCdbbosSwaggerPrUrl ?? null,
      tagCdbbosUrl: input?.tagCdbbosUrl ?? null,
      tagCdbbosConfigUrl: input?.tagCdbbosConfigUrl ?? null,
      dependencyJarBranchUrls: input?.dependencyJarBranchUrls ?? null,
      cdbUiArtifactPath: input?.cdbUiArtifactPath ?? null,
      cdbbosEarArtifactPath: input?.cdbbosEarArtifactPath ?? null,
      cdbbosConfigArtifactPath: input?.cdbbosConfigArtifactPath ?? null,
      branches: {
        cdbUi: input?.branches?.cdbUi ?? null,
        cdbUiConfigs: input?.branches?.cdbUiConfigs ?? null,
        freddy: input?.branches?.freddy ?? null,
      },
    };
  }

  /**
   * Patch the metadata of a release with a partial object, then immediately
   * run any checks that reference fields that changed.
   */
  async updateMetadata(
    releaseId: string,
    patch: Record<string, string | null>,
    actor?: string,
  ): Promise<Release> {
    const releases = await this.load();
    const release = releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    // Update intakePageUrl to the corresponding tech-governance intake list.
    let intakePageIdToUpdate: string | null = null;
    if (Object.prototype.hasOwnProperty.call(patch, 'intakePageUrl')) {
      const raw = patch['intakePageUrl'];
      const value = raw === '' ? null : raw;
      if (value !== null && value !== release.metadata.intakePageUrl) {
        const parsedPageId = parseConfluencePageIdFromUrl(value);
        if (!parsedPageId) {
          throw new Error(`Could not parse a Confluence page ID from URL: ${value}`);
        }
        try {
          await techGovernanceReleasesIntakeService.fetchConfluenceChildPagesDetails(parsedPageId);
        } catch (err: any) {
          throw new Error(
            `Intake Confluence page '${parsedPageId}' does not exist or could not be fetched: ${err?.message ?? err}`,
          );
        }
        intakePageIdToUpdate = parsedPageId;
      }
    }

    const changedFields: string[] = [];

    for (const [key, rawValue] of Object.entries(patch)) {
      // Coerce empty strings to null so the stored shape is consistent.
      const value = rawValue === '' ? null : rawValue;

      if (key.startsWith('branches.')) {
        const branchKey = key.slice('branches.'.length) as keyof ReleaseMetadata['branches'];
        if (!(branchKey in release.metadata.branches)) {
          throw new Error(`Unknown branches field: ${key}`);
        }
        const before = release.metadata.branches[branchKey];
        if (before !== value) {
          release.metadata.branches[branchKey] = value;
          changedFields.push(key);
        }
      } else {
        if (!(key in release.metadata)) {
          throw new Error(`Unknown metadata field: ${key}`);
        }
        if (key === 'branches') continue; // can't replace whole branches object via this path
        const before = (release.metadata as any)[key];
        if (before !== value) {
          (release.metadata as any)[key] = value;
          changedFields.push(key);
        }
      }
    }

    // Persist field changes immediately so a check run that throws still
    // leaves the field saved.
    release.updatedAt = new Date().toISOString();
    await this.save(releases);

    // If the intakePageUrl changed, propagate it to the corresponding tech governance entry.
    if (intakePageIdToUpdate) {
      try {
        await techGovernanceReleasesIntakeService.setIntakePageId(
          this.toGovernanceKey(releaseId),
          intakePageIdToUpdate,
        );
      } catch (err: any) {
        console.error(
          `[release-workflow] Failed to sync intakePageUrl to tech governance for '${releaseId}':`,
          err?.message ?? err,
        );
      }
    }

    // Re-run checks for every stage that uses any changed field, but only
    // for stages that aren't locked. We run them in memory against the
    // already-loaded release and persist once below, instead of letting each
    // runChecks() reload and rewrite the whole file per stage.
    const affectedStageChecks = new Map<string, Set<string>>();
    for (const field of changedFields) {
      for (const stageId of stagesUsingField(field)) {
        const checkIds = affectedStageChecks.get(stageId) ?? new Set<string>();
        const stage = release.stages.find((s) => s.id === stageId);
        if (stage) {
          for (const subStep of stage.subSteps) {
            if (subStep.editableField === field) {
              for (const checkId of subStep.autoTickedBy) {
                checkIds.add(checkId);
              }
            }
          }
        }
        affectedStageChecks.set(stageId, checkIds);
      }
    }

    let ranAnyChecks = false;
    for (const [stageId, checkIds] of affectedStageChecks.entries()) {
      const stage = release.stages.find((s) => s.id === stageId);
      if (!stage || stage.status === 'locked') continue;
      if (checkIds.size === 0) continue;
      try {
        const changed = await this.runChecksInMemory(release, stageId, actor, [...checkIds]);
        ranAnyChecks = ranAnyChecks || changed;
      } catch (err: any) {
        // Don't abort the whole patch if one stage's checks fail catastrophically;
        // the field is already saved. Log and continue.
        console.error(
          `[release-workflow] runChecks failed for ${releaseId}/${stageId} after metadata update:`,
          err?.message ?? err,
        );
      }
    }

    // Persist check results + auto-ticks once. Field changes were already
    // saved above, so skip a second write when no checks actually ran.
    if (ranAnyChecks) {
      await this.save(releases);
    }

    // `release` is the in-hand object we just mutated, so it already reflects
    // every check result — no extra reload needed.
    return release;
  }

  // ----- status auto-advance -----

  /**
   * Recompute every stage's status and the release's status from the
   * current sub-step state
   */
  private recomputeStatuses(release: Release): void {
    const now = new Date().toISOString();

    // Map for O(1) status lookup of dependency stages.
    const stageStatusById = new Map<string, Stage['status']>();
    for (const s of release.stages) stageStatusById.set(s.id, s.status);

    // Walk in displayOrder so dependsOn lookups see already-computed predecessors.
    const ordered = [...release.stages].sort((a, b) => a.displayOrder - b.displayOrder);

    for (const stage of ordered) {
      const newStatus = this.computeStageStatus(
        stage,
        stageStatusById,
        this.applicableSubSteps(release, stage),
      );

      if (newStatus !== stage.status) {
        // Side-effect timestamps on transitions.
        if (newStatus === 'in_progress' && !stage.startedAt) {
          stage.startedAt = now;
        }
        if (newStatus === 'complete' && !stage.closedAt) {
          stage.closedAt = now;
        }
        if (newStatus === 'ready' || newStatus === 'locked') {

        }
        stage.status = newStatus;
      }

      stageStatusById.set(stage.id, newStatus);
    }

    // Roll up to release-level status.
    release.status = this.computeReleaseStatus(release.stages);
  }

  private computeStageStatus(
    stage: Stage,
    stageStatusById: Map<string, Stage['status']>,
    applicableSubSteps: SubStep[],
  ): Stage['status'] {
    // Dependencies must all be complete to leave the locked state.
    if (stage.dependsOn && stage.dependsOn.length > 0) {
      const allDepsComplete = stage.dependsOn.every(
        (depId) => {
          const status = stageStatusById.get(depId);
          return status === 'complete' || status === 'skipped';
        },
      );
      if (!allDepsComplete) return 'locked';
    }

    if (applicableSubSteps.length === 0) {
      return 'skipped';
    }

    const allNa = applicableSubSteps.every((s) => s.state === 'n_a');
    if (allNa) return 'skipped';

    const allDone = applicableSubSteps.every(
      (s) => s.state === 'checked' || s.state === 'n_a',
    );
    if (allDone) return 'complete';

    const anyDone = applicableSubSteps.some(
      (s) => s.state === 'checked' || s.state === 'n_a',
    );
    if (anyDone) return 'in_progress';

    return 'ready';
  }

  private computeReleaseStatus(stages: Stage[]): Release['status'] {
    const activeStages = stages.filter((s) => s.status !== 'skipped');
    if (activeStages.length === 0) return 'complete';
    if (activeStages.every((s) => s.status === 'complete')) return 'complete';
    if (activeStages.every((s) => s.status === 'locked')) return 'not_started';
    return 'in_progress';
  }

  // ----- template reconciliation -----

  /**
   * Reconcile every persisted release against the current STAGE_TEMPLATE.
   */
  private async reconcileWithTemplate(): Promise<void> {
    const releases = await this.load();

    let totalChanges = 0;
    const changedReleaseIds: string[] = [];

    for (const releaseId of Object.keys(releases)) {
      const release = releases[releaseId];
      const releaseChanges = this.reconcileRelease(release);

      // Always recompute statuses on boot. This catches releases whose
      // sub-steps are all checked but whose stage.status is stale
      const statusBefore = JSON.stringify(release.stages.map((s) => s.status)) + '|' + release.status;
      this.recomputeStatuses(release);
      const statusAfter = JSON.stringify(release.stages.map((s) => s.status)) + '|' + release.status;
      if (statusBefore !== statusAfter) {
        releaseChanges.push('recomputed stage and release statuses from current sub-step state');
      }

      if (releaseChanges.length > 0) {
        totalChanges += releaseChanges.length;
        changedReleaseIds.push(releaseId);
        console.log(
          `[release-workflow] reconciled ${releaseId}: ${releaseChanges.length} change(s)`,
        );
        for (const change of releaseChanges) {
          console.log(`[release-workflow]   - ${change}`);
        }
      }
    }

    if (totalChanges > 0) {
      console.log(
        `[release-workflow] template reconciliation: ${totalChanges} change(s) across ${changedReleaseIds.length} release(s); persisting`,
      );
      await this.save(releases);
    }
  }

  /**
   * Apply template reconciliation to a single release IN PLACE.
   */
  private reconcileRelease(release: Release): string[] {
    const changes: string[] = [];

    const beforeSheriffFields = JSON.stringify({
      uiSheriff: release.uiSheriff ?? null,
      uiBackupSheriff: release.uiBackupSheriff ?? null,
      bosSheriff: release.bosSheriff ?? null,
      bosBackupSheriff: release.bosBackupSheriff ?? null,
    });
    const normalizedReleaseComponents = normalizeReleaseComponents(release.releaseComponents);
    const reconciledSheriffFields = buildSheriffAssignments({
      releaseComponents: normalizedReleaseComponents,
      uiSheriff: release.uiSheriff,
      uiBackupSheriff: release.uiBackupSheriff,
      bosSheriff: release.bosSheriff,
      bosBackupSheriff: release.bosBackupSheriff,
    });
    release.uiSheriff = reconciledSheriffFields.uiSheriff;
    release.uiBackupSheriff = reconciledSheriffFields.uiBackupSheriff;
    release.bosSheriff = reconciledSheriffFields.bosSheriff;
    release.bosBackupSheriff = reconciledSheriffFields.bosBackupSheriff;
    if (beforeSheriffFields !== JSON.stringify({
      uiSheriff: release.uiSheriff ?? null,
      uiBackupSheriff: release.uiBackupSheriff ?? null,
      bosSheriff: release.bosSheriff ?? null,
      bosBackupSheriff: release.bosBackupSheriff ?? null,
    })) {
      changes.push('backfilled component assignments to match current model shape');
    }

    const beforeReleaseComponents = JSON.stringify(release.releaseComponents ?? null);
    release.releaseComponents = normalizedReleaseComponents;
    if (beforeReleaseComponents !== JSON.stringify(release.releaseComponents)) {
      changes.push('backfilled release components to match current model shape');
    }

    const beforeKeys = Object.keys(release.metadata).sort().join(',');
    const beforeBranchKeys = Object.keys(release.metadata.branches ?? {}).sort().join(',');
    release.metadata = this.buildMetadata(release.metadata);
    const afterKeys = Object.keys(release.metadata).sort().join(',');
    const afterBranchKeys = Object.keys(release.metadata.branches).sort().join(',');
    if (beforeKeys !== afterKeys || beforeBranchKeys !== afterBranchKeys) {
      changes.push('backfilled metadata to match current model shape');
    }

    // Drop stages no longer present in the template (e.g. renamed/renumbered
    // stage IDs).
    const tplStageIds = new Set(STAGE_TEMPLATE.map((s) => s.id));
    const droppedStages = release.stages.filter((s) => !tplStageIds.has(s.id));
    if (droppedStages.length > 0) {
      release.stages = release.stages.filter((s) => tplStageIds.has(s.id));
      for (const dropped of droppedStages) {
        changes.push(`dropped orphan stage '${dropped.id}'`);
      }
    }

    for (const tplStage of STAGE_TEMPLATE) {
      const stage = release.stages.find((s) => s.id === tplStage.id);
      if (!stage) {
        // Whole stage missing on the release — unlikely, but possible if a
        // stage was added to the template after this release was created.
        // Clone the template stage and append.
        const cloned: Stage = JSON.parse(JSON.stringify(tplStage));
        release.stages.push(cloned);
        changes.push(`added missing stage '${tplStage.id}'`);
        continue;
      }

      // ----- sub-steps -----
      const tplSubStepIds = new Set(tplStage.subSteps.map((s) => s.id));

      // drop sub-steps no longer in template
      const droppedSubSteps = stage.subSteps.filter((s) => !tplSubStepIds.has(s.id));
      if (droppedSubSteps.length > 0) {
        stage.subSteps = stage.subSteps.filter((s) => tplSubStepIds.has(s.id));
        for (const dropped of droppedSubSteps) {
          changes.push(`${tplStage.id}: dropped orphan sub-step '${dropped.id}'`);
        }
      }

      // add sub-steps from template that aren't on the release
      for (const tplSub of tplStage.subSteps) {
        const existing = stage.subSteps.find((s) => s.id === tplSub.id);
        if (!existing) {
          stage.subSteps.push(JSON.parse(JSON.stringify(tplSub)));
          changes.push(`${tplStage.id}: added missing sub-step '${tplSub.id}'`);
        } else {
          // sync template-controlled fields
          if (existing.label !== tplSub.label) {
            existing.label = tplSub.label;
            changes.push(`${tplStage.id}: updated label on sub-step '${tplSub.id}'`);
          }
          if (!arraysEqual(existing.autoTickedBy, tplSub.autoTickedBy)) {
            existing.autoTickedBy = [...tplSub.autoTickedBy];
            changes.push(`${tplStage.id}: updated autoTickedBy on sub-step '${tplSub.id}'`);
          }
          if ((existing.editableField ?? null) !== (tplSub.editableField ?? null)) {
            existing.editableField = tplSub.editableField ?? null;
            changes.push(`${tplStage.id}: updated editableField on sub-step '${tplSub.id}'`);
          }
          if ((existing.inputType ?? 'text') !== (tplSub.inputType ?? 'text')) {
            existing.inputType = tplSub.inputType ?? 'text';
            changes.push(`${tplStage.id}: updated inputType on sub-step '${tplSub.id}'`);
          }
          if ((existing.track ?? 'generic') !== (tplSub.track ?? 'generic')) {
            existing.track = tplSub.track ?? 'generic';
            changes.push(`${tplStage.id}: updated track on sub-step '${tplSub.id}'`);
          }
          if ((existing.placeholder ?? null) !== (tplSub.placeholder ?? null)) {
            existing.placeholder = tplSub.placeholder ?? null;
            changes.push(`${tplStage.id}: updated placeholder on sub-step '${tplSub.id}'`);
          }
          if ((existing.helpUrl ?? null) !== (tplSub.helpUrl ?? null)) {
            existing.helpUrl = tplSub.helpUrl ?? null;
            changes.push(`${tplStage.id}: updated helpUrl on sub-step '${tplSub.id}'`);
          }
          if ((existing.helpUrlLabel ?? null) !== (tplSub.helpUrlLabel ?? null)) {
            existing.helpUrlLabel = tplSub.helpUrlLabel ?? null;
            changes.push(`${tplStage.id}: updated helpUrlLabel on sub-step '${tplSub.id}'`);
          }
        }
      }

      // restore template ordering
      stage.subSteps.sort(
        (a, b) => indexOf(tplStage.subSteps, (s) => s.id === a.id) - indexOf(tplStage.subSteps, (s) => s.id === b.id),
      );

      // ----- automated checks -----
      const tplCheckIds = new Set(tplStage.automatedChecks.map((c) => c.id));

      const droppedChecks = stage.automatedChecks.filter((c) => !tplCheckIds.has(c.id));
      if (droppedChecks.length > 0) {
        stage.automatedChecks = stage.automatedChecks.filter((c) => tplCheckIds.has(c.id));
        for (const dropped of droppedChecks) {
          changes.push(`${tplStage.id}: dropped orphan check '${dropped.id}'`);
        }
      }

      for (const tplCheck of tplStage.automatedChecks) {
        const existing = stage.automatedChecks.find((c) => c.id === tplCheck.id);
        if (!existing) {
          stage.automatedChecks.push(JSON.parse(JSON.stringify(tplCheck)));
          changes.push(`${tplStage.id}: added missing check '${tplCheck.id}'`);
        } else {
          if (existing.label !== tplCheck.label) {
            existing.label = tplCheck.label;
            changes.push(`${tplStage.id}: updated label on check '${tplCheck.id}'`);
          }
        }
      }

      stage.automatedChecks.sort(
        (a, b) => indexOf(tplStage.automatedChecks, (c) => c.id === a.id) - indexOf(tplStage.automatedChecks, (c) => c.id === b.id),
      );
    }

    return changes;
  }

  private applicableSubSteps(release: Release, stage: Stage): SubStep[] {
    return stage.subSteps.filter((subStep) => isTrackEnabledForRelease(subStep.track, release.releaseComponents));
  }
}

const releaseWorkflowService = new ReleaseWorkflowService();
export default releaseWorkflowService;

// ---------- module-level helpers (used by reconcile) ----------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function indexOf<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = 0; i < arr.length; i++) {
    if (pred(arr[i])) return i;
  }
  return arr.length; // unmatched items sort to the end
}

function normalizeReleaseComponents(
  input?: Partial<ReleaseComponents> | null,
): ReleaseComponents {
  return {
    cdbui: input?.cdbui ?? false,
    cdbbos: input?.cdbbos ?? false,
  };
}

function isTrackEnabledForRelease(
  track: SubStep['track'] | string | null | undefined,
  releaseComponents?: Partial<ReleaseComponents> | null,
): boolean {
  const normalizedTrack: SubStep['track'] = track === 'cdbui' || track === 'cdbbos' ? track : 'generic';
  if (normalizedTrack === 'generic') return true;
  const normalized = normalizeReleaseComponents(releaseComponents);
  return normalizedTrack === 'cdbui' ? normalized.cdbui : normalized.cdbbos;
}

function normalizeOptionalSheriff(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSheriffField(
  explicitValue: string | null | undefined,
  existingValue: string | null | undefined,
  enabled: boolean,
  fallbackValue: string | null,
): string | null {
  if (explicitValue !== undefined) {
    return normalizeOptionalSheriff(explicitValue);
  }

  const normalizedExisting = normalizeOptionalSheriff(existingValue);
  if (normalizedExisting) {
    return normalizedExisting;
  }

  return enabled ? fallbackValue : null;
}

function firstPresent(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalSheriff(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function buildSheriffAssignments(input: {
  releaseComponents: ReleaseComponents;
  uiSheriff?: string | null;
  uiBackupSheriff?: string | null;
  bosSheriff?: string | null;
  bosBackupSheriff?: string | null;
  existing?: Release;
}): Pick<Release, 'uiSheriff' | 'uiBackupSheriff' | 'bosSheriff' | 'bosBackupSheriff'> {
  const uiSheriff = resolveSheriffField(
    input.uiSheriff,
    input.existing?.uiSheriff,
    input.releaseComponents.cdbui,
    null,
  );
  const uiBackupSheriff = resolveSheriffField(
    input.uiBackupSheriff,
    input.existing?.uiBackupSheriff,
    input.releaseComponents.cdbui,
    null,
  );
  const bosSheriff = resolveSheriffField(
    input.bosSheriff,
    input.existing?.bosSheriff,
    input.releaseComponents.cdbbos,
    null,
  );
  const bosBackupSheriff = resolveSheriffField(
    input.bosBackupSheriff,
    input.existing?.bosBackupSheriff,
    input.releaseComponents.cdbbos,
    null,
  );

  return {
    uiSheriff,
    uiBackupSheriff,
    bosSheriff,
    bosBackupSheriff,
  };
}