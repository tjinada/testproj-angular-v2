import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import {
  DashboardDetailsResponse,
  EnvOption,
  LogSearchRequest,
  LogSearchResponse
} from '../models/log.model';

/**
 * Handles both:
 *   - Fetching the env list from the existing CDB Dashboard endpoint.
 *   - Calling the Mirror's new log-search endpoint.
 */
@Injectable({ providedIn: 'root' })
export class LogService {

  private readonly dashboardDetailsUrl = '/api/envs-dashboard/details';
  private readonly logSearchUrl = '/api/logs/search';

  constructor(private http: HttpClient) {}

  /**
   * Calls the existing dashboard endpoint and flattens `environments`
   * into an array of `{ name, applicationLogsUrl }`, skipping any env
   * without an `application_logs` value.
   */
  getEnvs(): Observable<EnvOption[]> {
    return this.http.get<DashboardDetailsResponse>(this.dashboardDetailsUrl).pipe(
      map((response) => {
        const envs = response?.environments || {};
        const options: EnvOption[] = [];
        for (const [name, config] of Object.entries(envs)) {
          const url = config?.application_logs;
          if (typeof url === 'string' && url.trim().length > 0) {
            options.push({ name, applicationLogsUrl: url.trim() });
          }
        }
        options.sort((a, b) => a.name.localeCompare(b.name));
        return options;
      })
    );
  }

  searchLogs(request: LogSearchRequest): Observable<LogSearchResponse> {
    return this.http.post<LogSearchResponse>(this.logSearchUrl, request);
  }
}
