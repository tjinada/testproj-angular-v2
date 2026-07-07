import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DynatraceResponse, EndpointMatch, SpanRecord, Timeframe, TraceMatch, UserEventRecord } from '../models/trace.model';
import { ConfigService } from './config.service';

export interface RequestIdLookupResponse {
  traceId: string;
  requestId: string;
}

export interface UrlSearchResponse {
  results: TraceMatch[];
}

export interface EndpointSearchResponse {
  results: EndpointMatch[];
}

/** Raw spans of the sampled 200-status traces for the components-by-URL
 *  search. The component list itself is derived client-side via
 *  buildFlowGraph() so it matches the flow diagram box-for-box. */
export interface ComponentSearchResponse {
  records: SpanRecord[];
  tracesAnalyzed: number;
  tracesRequested: number;
}

export interface LatestTraceResponse {
  traceId: string;
}

export interface SessionResponse {
  events: UserEventRecord[];
}

const TOKEN_STORAGE_PREFIX = 'dt-token-';

@Injectable({ providedIn: 'root' })
export class DynatraceService {

  private apiUrl = '/api/error-analyzer/traces';

  constructor(
    private http: HttpClient,
    private configService: ConfigService
  ) {}

  // ── Token helpers ──────────────────────────────────────────────────

  static getStoredToken(environment: string): string | null {
    const raw = localStorage.getItem(TOKEN_STORAGE_PREFIX + environment);
    return raw?.trim() || null;
  }

  static saveToken(environment: string, token: string): void {
    localStorage.setItem(TOKEN_STORAGE_PREFIX + environment, token.trim());
  }

  static removeToken(environment: string): void {
    localStorage.removeItem(TOKEN_STORAGE_PREFIX + environment);
  }

  private getUserToken(environment: string): string | undefined {
    if (!this.configService.isIndividualUserToken()) {
      return undefined;
    }
    return DynatraceService.getStoredToken(environment) || undefined;
  }

  // ── API methods ────────────────────────────────────────────────────

  fetchTrace(traceId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<DynatraceResponse> {
    return this.http.post<DynatraceResponse>(`${this.apiUrl}/${traceId}`, {
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  lookupTraceIdByRequestId(requestId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<RequestIdLookupResponse> {
    return this.http.post<RequestIdLookupResponse>(`${this.apiUrl}/lookup-by-request-id`, {
      requestId,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

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

  searchEndpoints(url: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<EndpointSearchResponse> {
    return this.http.post<EndpointSearchResponse>(`${this.apiUrl}/search-endpoints`, {
      url,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  searchComponents(urlPath: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<ComponentSearchResponse> {
    return this.http.post<ComponentSearchResponse>(`${this.apiUrl}/search-components`, {
      urlPath,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  findLatestTraceForEndpoint(urlPath: string, method: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<LatestTraceResponse> {
    return this.http.post<LatestTraceResponse>(`${this.apiUrl}/latest-for-endpoint`, {
      urlPath,
      method,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  searchByClientIp(clientIp: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<UrlSearchResponse> {
    return this.http.post<UrlSearchResponse>(`${this.apiUrl}/search-by-client-ip`, {
      clientIp,
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }

  fetchSession(sessionId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${this.apiUrl}/session/${sessionId}`, {
      environment,
      timeframe,
      userToken: this.getUserToken(environment)
    });
  }
}
