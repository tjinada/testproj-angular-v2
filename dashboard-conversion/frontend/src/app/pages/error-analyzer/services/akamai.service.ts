import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { AkamaiFlowRequest, AkamaiFlowResult } from '../models/akamai.model';

/**
 * Calls the backend's Akamai Flow endpoint.
 *
 * The backend does the full pipeline (parse URL → resolve hostname →
 * fetch rule tree → extract baseline → run naive matcher). This service
 * is a thin HTTP boundary — error handling and loading state live in
 * the component.
 *
 * Errors come through as HttpErrorResponse with status codes:
 *   400 — malformed URL                        → see AkamaiFlowParseError
 *   404 — hostname not on any monitored prop   → see AkamaiFlowHostnameError
 *   500 — PAPI failure or unexpected error     → see AkamaiFlowGenericError
 *
 * The component reads error.status to choose how to render.
 */
@Injectable({ providedIn: 'root' })
export class AkamaiService {

  private readonly flowUrl = '/api/akamai/flow';

  constructor(private http: HttpClient) {}

  /**
   * Submits a URL for evaluation. Returns the structured flow result
   * on success. Errors propagate as HttpErrorResponse — the component
   * is responsible for narrowing on .status.
   */
  resolveFlow(url: string): Observable<AkamaiFlowResult> {
    const body: AkamaiFlowRequest = { url };
    return this.http.post<AkamaiFlowResult>(this.flowUrl, body);
  }
}
