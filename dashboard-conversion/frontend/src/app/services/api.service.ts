import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, tap } from 'rxjs';
import {
  AppSettings,
  AppSettingsResponse,
  AppSettingsUpdateResponse,
  ReleasePrTrackerMutationResponse,
  ReleasePrTrackerResponse,
  RepoSummaryCard,
} from '../models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  notificationError = signal<string>('');
  notificationWarning = signal<string>('');
  notificationInfo = signal<string>('');

  constructor(private http: HttpClient) {}

  getAdminDashboard(): Observable<any> {
    return this.http.get('/api/app-data/dashboard');
  }

  getAppSettings(): Observable<AppSettingsResponse> {
    return this.http.get<AppSettingsResponse>('/api/app-data/settings').pipe(
      tap((res) => this.applyNotificationSettings(res.settings)),
    );
  }

  updateAppSettings(updates: Partial<AppSettings>): Observable<AppSettingsUpdateResponse> {
    return this.http.put<AppSettingsUpdateResponse>('/api/app-data/settings', updates).pipe(
      tap((res) => this.applyNotificationSettings(res.settings)),
    );
  }

  // Release PR tracker (admin-only)
  getReleasePrTracker(): Observable<ReleasePrTrackerResponse> {
    return this.http.get<ReleasePrTrackerResponse>('/api/release-pr-tracker');
  }

  addTrackedBranch(repo: string, branch: string): Observable<ReleasePrTrackerMutationResponse> {
    return this.http.post<ReleasePrTrackerMutationResponse>('/api/release-pr-tracker/branches', { repo, branch });
  }

  refreshTrackedBranch(id: string): Observable<ReleasePrTrackerMutationResponse> {
    return this.http.post<ReleasePrTrackerMutationResponse>(`/api/release-pr-tracker/branches/${id}/refresh`, {});
  }

  refreshRepoSummary(owner: string, repo: string): Observable<{ message: string; repoSummaries: RepoSummaryCard[] }> {
    return this.http.post<{ message: string; repoSummaries: RepoSummaryCard[] }>(
      `/api/release-pr-tracker/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/refresh`,
      {},
    );
  }

  removeTrackedBranch(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/release-pr-tracker/branches/${id}`);
  }

  private applyNotificationSettings(settings: Partial<AppSettings> | undefined): void {
    if (!settings) return;
    if ('notificationError' in settings) {
      this.notificationError.set(settings.notificationError ?? '');
    }
    if ('notificationWarning' in settings) {
      this.notificationWarning.set(settings.notificationWarning ?? '');
    }
    if ('notificationInfo' in settings) {
      this.notificationInfo.set(settings.notificationInfo ?? '');
    }
  }

  async request<T = any>(method: string, url: string, body?: any): Promise<T> {
    const request$ = method.toUpperCase() === 'GET' 
      ? this.http.get<T>(url)
      : method.toUpperCase() === 'POST'
      ? this.http.post<T>(url, body)
      : method.toUpperCase() === 'PUT'
      ? this.http.put<T>(url, body)
      : method.toUpperCase() === 'DELETE'
      ? this.http.delete<T>(url, { body })
      : this.http.request<T>(method, url, { body });

    return firstValueFrom(request$);
  }
}
