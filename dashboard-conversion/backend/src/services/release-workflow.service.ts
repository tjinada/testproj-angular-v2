/**
 * Release Workflow — service
 *
 * Owns persistence of release workflow state via Artifactory JSON.
 * Mirrors the existing tech-governance-releases-intake.service.ts pattern
 * (in production CDB Dashboard repo):
 *   - In-memory cache: releases: Record<releaseId, Release>
 *   - Hydrate on boot via artifactoryService.getFileContent
 *   - Save after every mutation via artifactoryService.saveFileContent
 *
 * SCOPE: skeleton only. runChecks() and per-stage check execution are NOT
 * implemented here — per-stage owners wire those in their own follow-up work.
 *
 * NOTE: artifactoryService is imported from a sibling service that exists
 * in the production repo. This dashboard-conversion folder does not include
 * it; the import resolves at merge-time.
 */

import artifactoryService from './artifactory.service';
import { cloneStageTemplate, STAGE_TEMPLATE } from './release-workflow.template';
import { STAGE_RUNNERS, StageRunnerMap } from './release-workflow.check-runners';
import {
  Release,
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

  // ----- persistence -----

  async initialize(): Promise<void> {
    try {
      const data = await artifactoryService.getFileContent(this.dataFilePath);
      this.releases = { ...data };
    } catch (error) {
      console.log('No existing release_workflow_data found in artifactory');
    }

    // Reconcile every existing release against the current STAGE_TEMPLATE.
    // Idempotent: no-op if release structure already matches the template.
    // Persists only if anything actually changed.
    await this.reconcileWithTemplate();
  }

  private async save(): Promise<void> {
    await artifactoryService.saveFileContent(this.dataFilePath, this.releases);
  }

  // ----- read -----

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
   * Throws if releaseId already exists.
   */
  async add(input: {
    releaseId: string;
    title: string;
    type: ReleaseType;
    sheriff: string;
    metadata?: Partial<ReleaseMetadata>;
  }): Promise<Release> {
    const { releaseId, title, type, sheriff, metadata } = input;

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
      status: 'in_progress',                  // newly-created releases open in-progress on Stage 1
      sheriff,
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

  // ----- update -----

  /**
   * Update top-level release metadata (title, sheriff, dates, etc).
   * Stage and sub-step mutations go through their own dedicated methods.
   */
  async update(
    releaseId: string,
    patch: Partial<Pick<Release, 'title' | 'sheriff' | 'metadata' | 'status'>>,
  ): Promise<Release> {
    const existing = this.releases[releaseId];
    if (!existing) {
      throw new Error(`Release '${releaseId}' not found`);
    }

    const updated: Release = {
      ...existing,
      ...patch,
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
   *
   * Dispatches by stageId to the per-stage check module. Each module
   * exports a `*_CHECK_RUNNERS` map keyed by check ID; we run them in
   * parallel, write the results back onto the stage's automatedChecks,
   * auto-tick any sub-step whose autoTickedBy includes a passing check,
   * and persist.
   *
   * Stages whose runners aren't yet implemented return their existing
   * automatedChecks unchanged (no fabricated data).
   */
  async runChecks(releaseId: string, stageId: string): Promise<AutomatedCheck[]> {
    const release = this.releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);

    const runners = this.getRunnersForStage(stageId);
    if (!runners) {
      // No runners registered for this stage yet — return the existing checks unchanged.
      return stage.automatedChecks;
    }

    // Run all checks in parallel; failures inside one check don't fail the whole batch.
    const updated = await Promise.all(
      stage.automatedChecks.map(async (check) => {
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
    this.applyAutoTicks(stage, updated);

    this.recomputeStatuses(release);

    release.updatedAt = new Date().toISOString();
    await this.save();
    return stage.automatedChecks;
  }

  /**
   * Returns the check-runner map for the given stage, or null if no
   * runners are registered for that stage yet.
   *
   * Runners live in release-workflow.check-runners.ts. Per-stage owners
   * add their stage's entries to that file's STAGE_RUNNERS map.
   */
  private getRunnersForStage(stageId: string): StageRunnerMap | null {
    return STAGE_RUNNERS[stageId] ?? null;
  }

  /**
   * For each passing check, auto-tick any sub-step that lists this check
   * in its autoTickedBy array, unless the sub-step has already been
   * manually checked (we don't want to clobber a 'manual' source with
   * 'auto').
   */
  private applyAutoTicks(stage: Stage, checks: AutomatedCheck[]): void {
    const now = new Date().toISOString();

    for (const check of checks) {
      if (check.status !== 'passed') continue;

      for (const subStep of stage.subSteps) {
        if (!subStep.autoTickedBy.includes(check.id)) continue;
        if (subStep.state === 'checked' && subStep.source === 'manual') continue;  // preserve manual override
        if (subStep.state === 'n_a') continue;                                     // preserve N/A

        subStep.state = 'checked';
        subStep.source = 'auto';
        subStep.completedAt = now;
        subStep.completedBy = 'system';
      }
    }
  }

  // ----- delete -----

  async delete(releaseId: string): Promise<boolean> {
    if (!this.releases[releaseId]) return false;
    delete this.releases[releaseId];
    await this.save();
    return true;
  }

  // ----- helpers -----

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
      branches: {
        cdbUi: input?.branches?.cdbUi ?? null,
        cdbUiConfigs: input?.branches?.cdbUiConfigs ?? null,
        freddy: input?.branches?.freddy ?? null,
      },
    };
  }

  /** Find a stage on a release by stage ID. Used by routes for validation. */
  findStage(releaseId: string, stageId: string): Stage | undefined {
    return this.releases[releaseId]?.stages.find((s) => s.id === stageId);
  }

  // ----- status auto-advance -----

  /**
   * Recompute every stage's status and the release's status from the
   * current sub-step state. Called after every mutation that could affect
   * stage completion (sub-step toggles, runChecks, create, update).
   *
   * Stage rules:
   *   - locked      : a dependsOn stage is not yet complete
   *   - complete    : all sub-steps are 'checked' or 'n_a'
   *   - in_progress : any sub-step is 'checked' or 'n_a' (some progress made)
   *   - ready       : eligible to start, no progress yet
   *
   * Release rules:
   *   - complete    : every stage complete
   *   - in_progress : at least one stage in_progress or ready
   *   - not_started : every stage locked (no progress anywhere)
   *
   * Idempotent. Sets startedAt/closedAt the first time a stage transitions
   * into in_progress / complete, but never overwrites an existing value.
   * Side-effects: mutates the release in place.
   */
  private recomputeStatuses(release: Release): void {
    const now = new Date().toISOString();

    // Map for O(1) status lookup of dependency stages.
    const stageStatusById = new Map<string, Stage['status']>();
    for (const s of release.stages) stageStatusById.set(s.id, s.status);

    // Walk in displayOrder so dependsOn lookups see already-computed predecessors.
    const ordered = [...release.stages].sort((a, b) => a.displayOrder - b.displayOrder);

    for (const stage of ordered) {
      const newStatus = this.computeStageStatus(stage, stageStatusById);

      if (newStatus !== stage.status) {
        // Side-effect timestamps on transitions.
        if (newStatus === 'in_progress' && !stage.startedAt) {
          stage.startedAt = now;
        }
        if (newStatus === 'complete' && !stage.closedAt) {
          stage.closedAt = now;
        }
        if (newStatus === 'ready' || newStatus === 'locked') {
          // If a stage drops back from in_progress (e.g. a sub-step was un-checked),
          // do NOT clear startedAt — it records when work began, regardless of
          // current state. closedAt likewise stays null until re-completed.
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
  ): Stage['status'] {
    // Dependencies must all be complete to leave the locked state.
    if (stage.dependsOn && stage.dependsOn.length > 0) {
      const allDepsComplete = stage.dependsOn.every(
        (depId) => stageStatusById.get(depId) === 'complete',
      );
      if (!allDepsComplete) return 'locked';
    }

    if (stage.subSteps.length === 0) {
      // Stage has no sub-steps (shouldn't happen with current template, but guard
      // anyway). Treat as ready until something else marks it complete.
      return 'ready';
    }

    const allDone = stage.subSteps.every(
      (s) => s.state === 'checked' || s.state === 'n_a',
    );
    if (allDone) return 'complete';

    const anyDone = stage.subSteps.some(
      (s) => s.state === 'checked' || s.state === 'n_a',
    );
    if (anyDone) return 'in_progress';

    return 'ready';
  }

  private computeReleaseStatus(stages: Stage[]): Release['status'] {
    if (stages.length === 0) return 'not_started';
    if (stages.every((s) => s.status === 'complete')) return 'complete';
    if (stages.every((s) => s.status === 'locked')) return 'not_started';
    return 'in_progress';
  }

  // ----- template reconciliation -----

  /**
   * Reconcile every persisted release against the current STAGE_TEMPLATE.
   *
   * For each stage on each release:
   *   - Drop sub-steps whose ID is no longer in the template stage
   *   - Add sub-steps from the template that don't exist on the release
   *   - Update label + autoTickedBy on existing sub-steps to match template
   *     (these are template-controlled; user-controlled state is preserved)
   *   - Same three operations for automatedChecks
   *
   * What is preserved: sub-step state/source/completedAt/completedBy;
   * check status/lastRunAt/result/errorMessage. User progress and runtime
   * state survive; only structural fields get re-synced.
   *
   * Runs once on boot. Logs only when changes are made.
   */
  private async reconcileWithTemplate(): Promise<void> {
    let totalChanges = 0;
    const changedReleaseIds: string[] = [];

    for (const releaseId of Object.keys(this.releases)) {
      const release = this.releases[releaseId];
      const releaseChanges = this.reconcileRelease(release);

      // Always recompute statuses on boot. This catches releases whose
      // sub-steps are all checked but whose stage.status is stale (e.g.
      // releases that pre-date the auto-advance logic). recomputeStatuses
      // is idempotent — a no-op when statuses already match — so the
      // call is safe even when no structural changes were made.
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
   * Returns a list of human-readable change descriptions for logging.
   * Empty list = no changes made.
   */
  private reconcileRelease(release: Release): string[] {
    const changes: string[] = [];

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
          if (existing.source !== tplCheck.source) {
            existing.source = tplCheck.source;
            changes.push(`${tplStage.id}: updated source on check '${tplCheck.id}'`);
          }
        }
      }

      stage.automatedChecks.sort(
        (a, b) => indexOf(tplStage.automatedChecks, (c) => c.id === a.id) - indexOf(tplStage.automatedChecks, (c) => c.id === b.id),
      );
    }

    return changes;
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
