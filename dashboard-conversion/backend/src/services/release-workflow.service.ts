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
import { cloneStageTemplate } from './release-workflow.template';
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

    release.updatedAt = now;
    await this.save();
    return subStep;
  }

  /**
   * Trigger automated checks for a stage.
   *
   * SKELETON: returns the stage's existing automatedChecks array unchanged.
   * Per-stage owners replace this with real GitHub / JIRA / Confluence /
   * Artifactory calls and update each check's status, lastRunAt, result.
   */
  async runChecks(releaseId: string, stageId: string): Promise<AutomatedCheck[]> {
    const release = this.releases[releaseId];
    if (!release) throw new Error(`Release '${releaseId}' not found`);

    const stage = release.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Stage '${stageId}' not found in release '${releaseId}'`);

    // No-op for skeleton. Per-stage teams will replace this with real calls.
    return stage.automatedChecks;
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
}

const releaseWorkflowService = new ReleaseWorkflowService();
export default releaseWorkflowService;
