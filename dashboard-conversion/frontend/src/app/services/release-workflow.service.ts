import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  Release,
  CreateReleaseInput,
  ReleaseComponents,
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

  getParticipatingDATeams(releaseId: string) {
    return this.http.get<{
      matched: { name: string; jiraProjects: string[]; scope?: string; devLead?: { name: string; email: string } }[];
      unmatched: string[];
      emailsByScope: Record<string, string>;
      teamsByScope: Record<string, { name: string; jiraProjects: string[]; scope?: string; devLead?: { name: string; email: string } }[]>;
      emails?: {
        cdbUI: { subject: string; to: string; body: string };
        cdbBOS: { subject: string; to: string; body: string };
      };
    }>(`${this.base}/${encodeURIComponent(releaseId)}/da-teams`);
  }

  refreshIntakes(releaseId: string): Observable<{ message: string; entry: unknown }> {
    return this.http.post<{ message: string; entry: unknown }>(
      `${this.base}/${encodeURIComponent(releaseId)}/intakes/refresh`,
      {},
    );
  }

  create(input: CreateReleaseInput): Observable<{ message: string; release: Release }> {
    return this.http.post<{ message: string; release: Release }>(this.base, input);
  }

  update(
    releaseId: string,
    patch: Partial<Pick<Release, 'title' | 'uiSheriff' | 'uiBackupSheriff' | 'bosSheriff' | 'bosBackupSheriff' | 'status'>> & {
      releaseComponents?: Partial<ReleaseComponents>;
      metadata?: Partial<ReleaseMetadata>;
    },
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

  updateStageNa(
    releaseId: string,
    stageId: string,
    body: { na: boolean; actor?: string },
  ): Observable<{ message: string; stage: Release['stages'][number] }> {
    return this.http.put<{ message: string; stage: Release['stages'][number] }>(
      `${this.base}/${encodeURIComponent(releaseId)}/stages/${encodeURIComponent(stageId)}/na`,
      body,
    );
  }

  runChecks(releaseId: string, stageId: string): Observable<{ checks: AutomatedCheck[] }> {
    return this.http.post<{ checks: AutomatedCheck[] }>(
      `${this.base}/${encodeURIComponent(releaseId)}/stages/${encodeURIComponent(stageId)}/run-checks`,
      {},
    );
  }

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