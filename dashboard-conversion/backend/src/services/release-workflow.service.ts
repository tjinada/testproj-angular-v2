import artifactoryService from './artifactory.service';
import {
  cloneStageTemplate,
  STAGE_TEMPLATE,
  STAGE_RUNNERS,
  StageRunnerMap,
  stagesUsingField,
} from './release-workflow.loader';
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
  private readonly dataFilePath = '/release_workflow_data.json';

  releases: ReleaseWorkflowData = {};

  constructor() {
    this.initialize();
  }

  async initialize(): Promise<void> {
    try {
      const data = await artifactoryService.getFileContent(this.dataFilePath);
      this.releases = { ...data };
    } catch (error) {
      console.log('No existing release_workflow_data found in artifactory');
    }

    // Reconcile every existing release against the current STAGE_TEMPLATE.
    await this.reconcileWithTemplate();
  }

  private async save(): Promise<void> {
    await artifactoryService.saveFileContent(this.dataFilePath, this.releases);
  }

  /** Returns the cached releases keyed by releaseId. */
  getAll(): ReleaseWorkflowData {
    return this.releases;
  }

  /** Returns a single release by ID, or undefined if not found. */
  getById(releaseId: string): Release | undefined {
    return this.releases[releaseId];
  }

  // ----- create -----

  /**
   * Add a new release. Clones the stage template and seeds metadata.
   */
  async add(input: {
    releaseId: string;
    title: string;
    type: ReleaseType;
    sheriff: string;
    backupSheriff?: string | null;
    releaseComponents?: Partial<ReleaseComponents>;
    metadata?: Partial<ReleaseMetadata>;
  }): Promise<Release> {
    const { releaseId, title, type, sheriff, backupSheriff, releaseComponents, metadata } = input;

    if (!releaseId || typeof releaseId !== 'string') {
      throw new Error('releaseId is required');
    }
    if (this.releases[releaseId]) {
      throw new Error(`Release '${releaseId}' already exists`);
    }

    const now = new Date().toISOString();

    const release: Release = {
      releaseId,
      title,
      type,
      status: 'in_progress',   // newly-created releases open in-progress on Stage 1
      sheriff,
      backupSheriff: normalizeOptionalSheriff(backupSheriff),
      releaseComponents: normalizeReleaseComponents(releaseComponents),
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

    this.releases[releaseId] = release;
    await this.save();
    return release;
  }

  /**
   * Update top-level release metadata (title, sheriff, dates, etc).
   */
  async update(
    releaseId: string,
    patch: Partial<Pick<Release, 'title' | 'sheriff' | 'backupSheriff' | 'metadata' | 'status'>> & {
      releaseComponents?: Partial<ReleaseComponents>;
    },
  ): Promise<Release> {
    const existing = this.releases[releaseId];
    if (!existing) {
      throw new Error(`Release '${releaseId}' not found`);
    }

    const updated: Release = {
      ...existing,
      title: patch.title ?? existing.title,
      sheriff: patch.sheriff ?? existing.sheriff,
      backupSheriff:
        patch.backupSheriff !== undefined
          ? normalizeOptionalSheriff(patch.backupSheriff)
          : normalizeOptionalSheriff(existing.backupSheriff),
      status: patch.status ?? existing.status,
      releaseComponents: patch.releaseComponents
        ? normalizeReleaseComponents({
            ...normalizeReleaseComponents(existing.releaseComponents),
            ...patch.releaseComponents,
          })
        : normalizeReleaseComponents(existing.releaseComponents),
      metadata: patch.metadata ? { ...existing.metadata, ...patch.metadata } : existing.metadata,
      updatedAt: new Date().toISOString(),
    };

    this.recomputeStatuses(updated);

    this.releases[releaseId] = updated;
    await this.save();
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
    const release = this.releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);

    const subStep = stage.subSteps.find((s) => s.id === subStepId);
    if (!subStep) throw new Error(`Sub-step '${subStepId}' not found in stage '${stageId}'`);

    const now = new Date().toISOString();
    subStep.state = patch.state;
    subStep.source = patch.state === 'unchecked' ? null : patch.source;
    subStep.completedAt = patch.state === 'unchecked' ? null : now;
    subStep.completedBy = patch.state === 'unchecked' ? null : (patch.actor ?? 'unknown');

    this.recomputeStatuses(release);

    release.updatedAt = now;
    await this.save();
    return subStep;
  }

  /**
   * Trigger automated checks for a stage.
   */
  async runChecks(
    releaseId: string,
    stageId: string,
    actor?: string,
    specificCheckIds?: string[],
  ): Promise<AutomatedCheck[]> {
    const release = this.releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);

    const runners = this.getRunnersForStage(stageId);
    if (!runners) {
      // No runners registered for this stage yet — return the existing checks unchanged.
      return stage.automatedChecks;
    }

    const applicableCheckIds = new Set(
      this.applicableSubSteps(release, stage).flatMap((subStep) => subStep.autoTickedBy),
    );
    if (applicableCheckIds.size === 0) {
      return stage.automatedChecks;
    }

    let checkIdsToRun = applicableCheckIds;
    if (specificCheckIds && specificCheckIds.length > 0) {
      const requestedCheckIds = new Set(specificCheckIds);
      checkIdsToRun = new Set([...applicableCheckIds].filter((id) => requestedCheckIds.has(id)));
    }
    if (checkIdsToRun.size === 0) {
      return stage.automatedChecks;
    }

    // Run all checks in parallel; failures inside one check don't fail the whole batch.
    const updated = await Promise.all(
      stage.automatedChecks.map(async (check) => {
        if (!checkIdsToRun.has(check.id)) return check;
        const runner = runners[check.id];
        if (!runner) return check;
        // mark as running so the response (or a refetch mid-flight) reflects activity
        check.status = 'running';
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
    await this.save();
    return stage.automatedChecks;
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
    if (!this.releases[releaseId]) return false;
    delete this.releases[releaseId];
    await this.save();
    return true;
  }
  
  private buildMetadata(input?: Partial<ReleaseMetadata>): ReleaseMetadata {
    return {
      preProdDate: input?.preProdDate ?? null,
      prodDate: input?.prodDate ?? null,
      jiraTracker: input?.jiraTracker ?? null,
      intakePageId: input?.intakePageId ?? null,
      intakeSheetUrl: input?.intakeSheetUrl ?? null,
      confluencePageId: input?.confluencePageId ?? null,
      fixVersion: input?.fixVersion ?? null,
      envMatrixPrUrl: input?.envMatrixPrUrl ?? null,
      cdbUiConfigJiraUrl: input?.cdbUiConfigJiraUrl ?? null,
      sealightsDisablePrUrl: input?.sealightsDisablePrUrl ?? null,
      preProdLetterUrl: input?.preProdLetterUrl ?? null,
      prodLetterUrl: input?.prodLetterUrl ?? null,
      retrofitCdbUiPrUrl: input?.retrofitCdbUiPrUrl ?? null,
      retrofitCdbConfigsPrUrl: input?.retrofitCdbConfigsPrUrl ?? null,
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
      tagCdbbosUrl: input?.tagCdbbosUrl ?? null,
      tagCdbbosConfigUrl: input?.tagCdbbosConfigUrl ?? null,
      dependencyJarBranchUrls: input?.dependencyJarBranchUrls ?? null,
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
    const release = this.releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

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
    await this.save();

    // Re-run checks for every stage that uses any changed field, but only
    // for stages that aren't locked. runChecks() persists internally on
    // each call.
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

    for (const [stageId, checkIds] of affectedStageChecks.entries()) {
      const stage = release.stages.find((s) => s.id === stageId);
      if (!stage || stage.status === 'locked') continue;
      if (checkIds.size === 0) continue;
      try {
        await this.runChecks(releaseId, stageId, actor, [...checkIds]);
      } catch (err: any) {
        // Don't abort the whole patch if one stage's checks fail catastrophically;
        // the field is already saved. Log and continue.
        console.error(
          `[release-workflow] runChecks failed for ${releaseId}/${stageId} after metadata update:`,
          err?.message ?? err,
        );
      }
    }

    return this.releases[releaseId];
  }

  /** Find a stage on a release by stage ID. Used by routes for validation. */
  findStage(releaseId: string, stageId: string): Stage | undefined {
    return this.releases[releaseId]?.stages.find((s) => s.id === stageId);
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
    let totalChanges = 0;
    const changedReleaseIds: string[] = [];

    for (const releaseId of Object.keys(this.releases)) {
      const release = this.releases[releaseId];
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
      await this.save();
    }
  }

  /**
   * Apply template reconciliation to a single release IN PLACE.
   */
  private reconcileRelease(release: Release): string[] {
    const changes: string[] = [];

    const beforeBackupSheriff = release.backupSheriff ?? null;
    release.backupSheriff = normalizeOptionalSheriff(release.backupSheriff);
    if (beforeBackupSheriff !== release.backupSheriff) {
      changes.push('backfilled backup sheriff to match current model shape');
    }

    const beforeReleaseComponents = JSON.stringify(release.releaseComponents ?? null);
    release.releaseComponents = normalizeReleaseComponents(release.releaseComponents);
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