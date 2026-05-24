/**
 * Release Workflow — frontend HTTP service
 *
 * Thin wrapper over /api/release-workflow endpoints.
 */

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  Release,
  CreateReleaseInput,
  ReleaseMetadata,
  AutomatedCheck,
  SubStep,
  SubStepSource,
  SubStepState,
} from '../models/release-workflow.model';

@Injectable({ providedIn: 'root' })
export class ReleaseWorkflowService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/release-workflow';

  list(): Observable<Release[]> {
    return this.http.get<Release[]>(this.base);
  }

  getById(releaseId: string): Observable<Release> {
    return this.http.get<Release>(`${this.base}/${encodeURIComponent(releaseId)}`);
  }

  create(input: CreateReleaseInput): Observable<{ message: string; release: Release }> {
    return this.http.post<{ message: string; release: Release }>(this.base, input);
  }

  update(
    releaseId: string,
    patch: Partial<Pick<Release, 'title' | 'sheriff' | 'status'>> & { metadata?: Partial<ReleaseMetadata> },
  ): Observable<{ message: string; release: Release }> {
    return this.http.put<{ message: string; release: Release }>(
      `${this.base}/${encodeURIComponent(releaseId)}`,
      patch,
    );
  }

  updateSubStep(
    releaseId: string,
    stageId: string,
    subStepId: string,
    body: { state: SubStepState; source: SubStepSource; actor?: string },
  ): Observable<{ message: string; subStep: SubStep }> {
    return this.http.put<{ message: string; subStep: SubStep }>(
      `${this.base}/${encodeURIComponent(releaseId)}/stages/${encodeURIComponent(stageId)}/sub-steps/${encodeURIComponent(subStepId)}`,
      body,
    );
  }

  runChecks(releaseId: string, stageId: string): Observable<{ checks: AutomatedCheck[] }> {
    return this.http.post<{ checks: AutomatedCheck[] }>(
      `${this.base}/${encodeURIComponent(releaseId)}/stages/${encodeURIComponent(stageId)}/run-checks`,
      {},
    );
  }

  /**
   * Patch one or more metadata fields. Backend persists then re-runs checks
   * for any stages that reference the changed fields. Returns the updated
   * release.
   *
   * If `actor` is provided, it's used as the completedBy on any sub-step
   * that newly transitions to auto-checked as a result of this patch —
   * crediting the user who pasted the URL rather than 'system'.
   *
   * Patch shape:
   *   { 'intakePageId': '1110606115' }
   *   { 'branches.cdbUiConfigs': 'https://github.com/.../tree/release/r85.0.0' }
   *   { 'fixVersion': null }    // clear the field
   */
  updateMetadata(
    releaseId: string,
    patch: Record<string, string | null>,
    actor?: string,
  ): Observable<{ message: string; release: Release }> {
    const body: Record<string, string | null | undefined> = { ...patch };
    if (actor) body['actor'] = actor;
    return this.http.patch<{ message: string; release: Release }>(
      `${this.base}/${encodeURIComponent(releaseId)}/metadata`,
      body,
    );
  }

  delete(releaseId: string): Observable<{ message: string; releaseId: string }> {
    return this.http.delete<{ message: string; releaseId: string }>(
      `${this.base}/${encodeURIComponent(releaseId)}`,
    );
  }
}
