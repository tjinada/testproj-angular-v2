import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { UrlTraceRequest, UrlTraceResponse } from '../models/url-trace.model';

/**
 * Calls the backend's URL Trace endpoint. Thin HTTP boundary —
 * error handling and loading state live in the component.
 *
 * Errors propagate as HttpErrorResponse with status codes:
 *   400 — malformed URL or missing input
 *   500 — unexpected server error
 *
 * Note: a successful 200 response can still carry `error: <string>` in
 * the body when the chain was aborted mid-flight (network failure,
 * max-redirect cap). The component handles both forms.
 */
@Injectable({ providedIn: 'root' })
export class UrlTraceService {

  private readonly http = inject(HttpClient);
  private readonly flowUrl = '/api/url-trace/flow';

  trace(url: string, headers?: Record<string, string>): Observable<UrlTraceResponse> {
    const body: UrlTraceRequest = { url };
    if (headers && Object.keys(headers).length > 0) {
      body.headers = headers;
    }
    return this.http.post<UrlTraceResponse>(this.flowUrl, body);
  }
}
