import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DynatraceResponse, Timeframe, TraceMatch } from '../models/trace.model';

export interface RequestIdLookupResponse {
  traceId: string;
  requestId: string;
}

export interface UrlSearchResponse {
  results: TraceMatch[];
}

@Injectable({ providedIn: 'root' })
export class DynatraceService {

  private apiUrl = '/api/traces';

  constructor(private http: HttpClient) {}

  /**
   * Fetches trace data from the backend by trace ID.
   * Backend handles the 2-step Dynatrace execute + poll flow.
   */
  fetchTrace(traceId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<DynatraceResponse> {
    return this.http.post<DynatraceResponse>(`${this.apiUrl}/${traceId}`, {
      environment,
      timeframe
    });
  }

  /**
   * Resolves a request ID to a trace ID via the backend lookup endpoint.
   */
  lookupTraceIdByRequestId(requestId: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<RequestIdLookupResponse> {
    return this.http.post<RequestIdLookupResponse>(`${this.apiUrl}/lookup-by-request-id`, {
      requestId,
      environment,
      timeframe
    });
  }

  /**
   * Searches for traces matching a full URL (hostname + path). Returns a
   * deduplicated list of trace matches sorted by most recent first.
   */
  searchByUrl(url: string, environment: string = 'NON-PROD', timeframe?: Timeframe): Observable<UrlSearchResponse> {
    return this.http.post<UrlSearchResponse>(`${this.apiUrl}/search-by-url`, {
      url,
      environment,
      timeframe
    });
  }
}
