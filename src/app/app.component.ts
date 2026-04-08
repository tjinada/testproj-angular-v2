import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SearchComponent, SearchEvent } from './components/search/search.component';
import { TraceResultsComponent } from './components/trace-results/trace-results.component';
import { DynatraceService } from './services/dynatrace.service';
import { ConfigService } from './services/config.service';
import { SpanRecord } from './models/trace.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, SearchComponent, TraceResultsComponent],
  template: `
    <div class="app-container">
      <h1 class="app-title">TESTPROJ Error Analyzer</h1>
      <app-search (search)="onSearch($event)"></app-search>
      <div *ngIf="resolvedFromRequestId" class="resolved-banner">
        Found trace <code>{{ resolvedFromRequestId.traceId }}</code>
        for request <code>{{ resolvedFromRequestId.requestId }}</code>
      </div>
      <app-trace-results
        [spans]="spans"
        [isLoading]="isLoading"
        [errorMsg]="errorMsg"
        [environment]="environment"
        [envHostnamePatterns]="envHostnamePatterns">
      </app-trace-results>
    </div>
  `,
  styles: [`
    .app-container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    .app-title {
      font-size: 20px;
      font-weight: 600;
      color: #1B4F72;
      margin: 0 0 20px 0;
    }
    .resolved-banner {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e40af;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .resolved-banner code {
      font-family: monospace;
      background: #dbeafe;
      padding: 1px 6px;
      border-radius: 3px;
    }
  `]
})
export class AppComponent implements OnInit {
  spans: SpanRecord[] = [];
  isLoading = false;
  errorMsg = '';
  environment = 'NON-PROD';
  envHostnamePatterns: string[] = [];
  resolvedFromRequestId: { traceId: string; requestId: string } | null = null;

  constructor(
    private dynatraceService: DynatraceService,
    private configService: ConfigService
  ) {}

  async ngOnInit(): Promise<void> {
    await this.configService.load();
    this.envHostnamePatterns = this.configService.getEnvHostnamePatterns();
  }

  onSearch(event: SearchEvent): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.spans = [];
    this.resolvedFromRequestId = null;

    if (event.mode === 'trace') {
      this.fetchTrace(event.value);
      return;
    }

    // Request ID mode: resolve to trace ID first, then fetch the trace
    const requestId = event.value;
    this.dynatraceService.lookupTraceIdByRequestId(requestId, this.environment).subscribe({
      next: (response) => {
        this.resolvedFromRequestId = { traceId: response.traceId, requestId: response.requestId };
        this.fetchTrace(response.traceId);
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to look up request ID. Please try again.';
        this.isLoading = false;
      }
    });
  }

  private fetchTrace(traceId: string): void {
    this.dynatraceService.fetchTrace(traceId, this.environment).subscribe({
      next: (response) => {
        this.spans = response.result?.records || [];
        if (this.spans.length === 0) {
          this.errorMsg = 'No spans found for this trace ID. Check the trace ID and try again.';
        }
        this.isLoading = false;
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to fetch trace data. Please try again.';
        this.isLoading = false;
      }
    });
  }
}
