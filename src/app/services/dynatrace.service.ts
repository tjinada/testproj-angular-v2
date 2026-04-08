import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DynatraceResponse } from '../models/trace.model';

export interface RequestIdLookupResponse {
  traceId: string;
  requestId: string;
}

@Injectable({ providedIn: 'root' })
export class DynatraceService {

  private apiUrl = '/api/traces';

  constructor(private http: HttpClient) {}

  /**
   * Fetches trace data from the backend by trace ID.
   * Backend handles the 2-step Dynatrace execute + poll flow.
   */
  fetchTrace(traceId: string, environment: string = 'NON-PROD', timeframe?: { from: string; to: string }): Observable<DynatraceResponse> {
    return this.http.post<DynatraceResponse>(`${this.apiUrl}/${traceId}`, {
      environment,
      timeframe
    });
  }

  /**
   * Resolves a request ID to a trace ID via the backend lookup endpoint.
   */
  lookupTraceIdByRequestId(requestId: string, environment: string = 'NON-PROD'): Observable<RequestIdLookupResponse> {
    return this.http.post<RequestIdLookupResponse>(`${this.apiUrl}/lookup-by-request-id`, {
      requestId,
      environment
    });
  }
}
