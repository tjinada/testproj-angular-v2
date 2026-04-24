import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface OpenSearchTestResponse {
  raw: unknown;
  status: number;
  elapsedMs: number;
  url: string;
}

/**
 * Calls the Mirror's OpenSearch test endpoint.
 */
@Injectable({ providedIn: 'root' })
export class OpenSearchService {

  private readonly searchUrl = '/api/opensearch/search';

  constructor(private http: HttpClient) {}

  search(searchTerm: string, timeRangeMs: number): Observable<OpenSearchTestResponse> {
    return this.http.post<OpenSearchTestResponse>(this.searchUrl, { searchTerm, timeRangeMs });
  }
}
