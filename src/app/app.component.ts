import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchComponent, SearchEvent } from './components/search/search.component';
import { TraceResultsComponent } from './components/trace-results/trace-results.component';
import { DynatraceService } from './services/dynatrace.service';
import { ConfigService, EnvironmentOption } from './services/config.service';
import { SpanRecord, Timeframe } from './models/trace.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchComponent, TraceResultsComponent],
  template: `
    <div class="app-container">
      <h1 class="app-title">TESTPROJ Error Analyzer</h1>

      <div *ngIf="configLoaded" class="env-row" [class.env-row-prod]="isProd()">
        <label for="env-select" class="env-label">Environment:</label>
        <select
          id="env-select"
          class="env-select"
          [class.env-select-prod]="isProd()"
          [(ngModel)]="environment">
          <option *ngFor="let env of environments" [ngValue]="env.id">{{ env.label }}</option>
        </select>
        <span *ngIf="isProd()" class="env-prod-badge">PROD</span>
      </div>

      <app-search (search)="onSearch($event)"></app-search>
      <div *ngIf="resolvedFromRequestId" class="resolved-banner">
        Found trace <code>{{ resolvedFromRequestId.traceId }}</code>
        for request <code>{{ resolvedFromRequestId.requestId }}</code>
        in <strong>{{ currentEnvLabel() }}</strong>
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
    .env-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding: 8px 12px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
    }
    .env-row-prod {
      border-color: #dc2626;
      background: #fef2f2;
    }
    .env-label {
      font-size: 13px;
      font-weight: 600;
      color: #374151;
    }
    .env-select {
      height: 32px;
      padding: 0 28px 0 10px;
      background-color: #f9fafb;
      color: #374151;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3e%3cpath fill='%236b7280' d='M6 8.5L1.5 4h9z'/%3e%3c/svg%3e");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }
    .env-select-prod {
      border-color: #dc2626;
      background-color: #fee2e2;
      color: #991b1b;
    }
    .env-prod-badge {
      display: inline-block;
      padding: 2px 8px;
      background: #dc2626;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      border-radius: 3px;
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
  environments: EnvironmentOption[] = [];
  envHostnamePatterns: string[] = [];
  resolvedFromRequestId: { traceId: string; requestId: string } | null = null;
  configLoaded = false;

  constructor(
    private dynatraceService: DynatraceService,
    private configService: ConfigService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit(): Promise<void> {
    await this.configService.load();
    this.envHostnamePatterns = this.configService.getEnvHostnamePatterns();
    this.environments = this.configService.getEnvironments();
    // Always default to Non-Prod every session, regardless of what's available.
    const nonProd = this.environments.find(e => !e.isProd);
    this.environment = nonProd ? nonProd.id : (this.environments[0]?.id || 'NON-PROD');
    this.configLoaded = true;
    // Force a change detection pass — without this, the env-row may not
    // render until a user interaction triggers CD (zone.js timing issue).
    this.cdr.detectChanges();
  }

  isProd(): boolean {
    const current = this.environments.find(e => e.id === this.environment);
    return !!current?.isProd;
  }

  currentEnvLabel(): string {
    return this.environments.find(e => e.id === this.environment)?.label || this.environment;
  }

  onSearch(event: SearchEvent): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.spans = [];
    this.resolvedFromRequestId = null;

    if (event.mode === 'trace') {
      this.fetchTrace(event.value, event.timeframe);
      return;
    }

    // Request ID mode: resolve to trace ID first, then fetch the trace
    const requestId = event.value;
    this.dynatraceService.lookupTraceIdByRequestId(requestId, this.environment, event.timeframe).subscribe({
      next: (response) => {
        this.resolvedFromRequestId = { traceId: response.traceId, requestId: response.requestId };
        this.fetchTrace(response.traceId, event.timeframe);
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to look up request ID. Please try again.';
        this.isLoading = false;
      }
    });
  }

  private fetchTrace(traceId: string, timeframe: Timeframe): void {
    this.dynatraceService.fetchTrace(traceId, this.environment, timeframe).subscribe({
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
