import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DynatraceResponse, Timeframe, TraceMatch, UserEventRecord } from '../models/trace.model';
import { ConfigService } from './config.service';

export interface RequestIdLookupResponse {
  traceId: string;
  requestId: string;
}

export interface UrlSearchResponse {
  results: TraceMatch[];
}

export interface SessionResponse {
  events: UserEventRecord[];
}

/** localStorage key prefix for user-provided Dynatrace tokens. */
const TOKEN_STORAGE_PREFIX = 'dt-token-';

@Injectable({ providedIn: 'root' })
export class DynatraceService {

  private apiUrl = '/api/traces';

  constructor(
    private http: HttpClient,
    private configService: ConfigService
  ) {}

  // ── Token helpers ──────────────────────────────────────────────────

  /**
   * Returns the user-provided token for the given environment from
   * localStorage, or null if not set.
   */
  static getStoredToken(environment: string): string | null {
    const raw = localStorage.getItem(TOKEN_STORAGE_PREFIX + environment);
    return raw?.trim() || null;
  }

  /**
   * Persists a user-provided token for the given environment.
   */
  static saveToken(environment: string, token: string): void {
    localStorage.setItem(TOKEN_STORAGE_PREFIX + environment, token.trim());
  }

  /**
   * Removes the stored token for the given environment.
   */
  static removeToken(environment: string): void {
    localStorage.removeItem(TOKEN_STORAGE_PREFIX + environment);
  }

  /**
   * Returns the userToken to include in API requests, or undefined when
   * individual token mode is off (so the backend uses its .env token).
   */
  private getUserToken(environment: string): string | undefined {
    if (!this.configService.isIndividualUserToken()) {
      return undefined;
    }
    return DynatraceService.getStoredToken(environment) || undefined;
  }

  // ── API methods ────────────────────────────────────────────────────

  /**
   * Fetches trace data from the backend by trace ID.
   * Backend handles the 2-step Dynatrace execute + poll flow.
   */
  fetchTrace(traceId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<DynatraceResponse> {
    return this.http.post<DynatraceResponse>(`${this.apiUrl}/${traceId}`, {
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  /**
   * Resolves a request ID to a trace ID via the backend lookup endpoint.
   */
  lookupTraceIdByRequestId(requestId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<RequestIdLookupResponse> {
    return this.http.post<RequestIdLookupResponse>(`${this.apiUrl}/lookup-by-request-id`, {
      requestId,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  /**
   * Searches for traces matching a full URL (hostname + path). Returns a
   * deduplicated list of trace matches sorted by most recent first.
   *
   * When hostExact is true, the backend uses an exact hostname match instead
   * of contains(). Used by the session "Find backend traces" flow where the
   * full FQDN is known and cross-environment pollution must be avoided.
   */
  searchByUrl(
    url: string,
    environment: string = 'NON-PROD',
    timeframe?: Timeframe,
    hostExact: boolean = false
  ): Observable<UrlSearchResponse> {
    return this.http.post<UrlSearchResponse>(`${this.apiUrl}/search-by-url`, {
      url,
      environment,
      timeframe,
      hostExact,
      userToken: this.getUserToken(environment)
    });
  }

  /**
   * Searches for traces by JSESSIONID. The backend follows the chain of
   * session ID rotations via Set-Cookie response headers.
   */
  searchByJsession(
    jsessionId: string,
    environment: string = 'NON-PROD',
    timeframe?: Timeframe
  ): Observable<UrlSearchResponse> {
    return this.http.post<UrlSearchResponse>(`${this.apiUrl}/search-by-jsession`, {
      jsessionId,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  /**
   * Fetches all user.events records for a given RUM session ID. The backend
   * handles the 2-step Dynatrace execute + poll flow.
   */
  fetchSession(sessionId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${this.apiUrl}/session/${sessionId}`, {
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }
}
