import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchComponent, SearchEvent } from './components/search/search.component';
import { TraceResultsComponent } from './components/trace-results/trace-results.component';
import { TraceResultsTableComponent } from './components/trace-results-table/trace-results-table.component';
import { SessionResultsComponent } from './components/session-results/session-results.component';
import { TokenSetupComponent } from './components/token-setup/token-setup.component';
import { DynatraceService } from './services/dynatrace.service';
import { ConfigService, EnvironmentOption } from './services/config.service';
import { SpanRecord, Timeframe, TraceMatch, UserEventRecord } from './models/trace.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchComponent, TraceResultsComponent, TraceResultsTableComponent, SessionResultsComponent, TokenSetupComponent],
  template: `
    <div class="app-container">
      <div class="app-header-row">
        <h1 class="app-title">TESTPROJ Error Analyzer</h1>
        <button
          *ngIf="showSettingsGear"
          class="settings-btn"
          (click)="openSettings()"
          title="Token Settings">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" stroke="#6b7280" stroke-width="1.5"/>
            <path d="M16.2 12.2a1.4 1.4 0 00.28 1.54l.05.05a1.7 1.7 0 01-1.2 2.9 1.7 1.7 0 01-1.2-.5l-.05-.05a1.4 1.4 0 00-1.54-.28 1.4 1.4 0 00-.84 1.28v.14a1.7 1.7 0 01-3.4 0v-.08a1.4 1.4 0 00-.92-1.28 1.4 1.4 0 00-1.54.28l-.05.05a1.7 1.7 0 01-2.4-2.4l.05-.05a1.4 1.4 0 00.28-1.54 1.4 1.4 0 00-1.28-.84H2.3a1.7 1.7 0 010-3.4h.08a1.4 1.4 0 001.28-.92 1.4 1.4 0 00-.28-1.54l-.05-.05a1.7 1.7 0 012.4-2.4l.05.05a1.4 1.4 0 001.54.28h.07a1.4 1.4 0 00.84-1.28V2.3a1.7 1.7 0 013.4 0v.08a1.4 1.4 0 00.84 1.28 1.4 1.4 0 001.54-.28l.05-.05a1.7 1.7 0 012.4 2.4l-.05.05a1.4 1.4 0 00-.28 1.54v.07a1.4 1.4 0 001.28.84h.14a1.7 1.7 0 010 3.4h-.08a1.4 1.4 0 00-1.28.84z"
              stroke="#6b7280" stroke-width="1.5"/>
          </svg>
        </button>
      </div>

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

      <!-- Token setup modal (first-time) -->
      <app-token-setup
        *ngIf="showTokenSetup"
        [mode]="'setup'"
        [environments]="nonProdEnvironments"
        [tokenUrls]="tokenUrls"
        (saved)="onTokenSetupDone()">
      </app-token-setup>

      <!-- Token settings modal (gear) -->
      <app-token-setup
        *ngIf="showTokenSettings"
        [mode]="'settings'"
        [environments]="environments"
        [tokenUrls]="tokenUrls"
        (saved)="onTokenSettingsDone()"
        (closed)="onTokenSettingsDone()">
      </app-token-setup>

      <!-- Main app content (hidden when setup modal is blocking) -->
      <ng-container *ngIf="!showTokenSetup">
        <app-search (search)="onSearch($event)"></app-search>
        <div *ngIf="resolvedFromRequestId" class="resolved-banner">
          Found trace <code>{{ resolvedFromRequestId.traceId }}</code>
          for request <code>{{ resolvedFromRequestId.requestId }}</code>
          in <strong>{{ currentEnvLabel() }}</strong>
        </div>

        <app-session-results
          [events]="sessionEvents"
          [isLoading]="isLoading && lastSearchMode === 'session'"
          [errorMsg]="errorMsg"
          (findTraces)="onFindBackendTraces($event)">
        </app-session-results>

        <div *ngIf="tracesFromSessionUrl" class="resolved-banner">
          Backend traces matching <code>{{ tracesFromSessionUrl }}</code>
        </div>

        <app-trace-results-table
          [results]="urlSearchResults"
          [selectedTraceId]="selectedTraceId"
          [limitReached]="urlSearchLimitReached"
          (resultClick)="onUrlResultClick($event)">
        </app-trace-results-table>

        <app-trace-results
          [spans]="spans"
          [isLoading]="isLoading"
          [errorMsg]="errorMsg"
          [environment]="environment"
          [envHostnamePatterns]="envHostnamePatterns">
        </app-trace-results>
      </ng-container>
    </div>
  `,
  styles: [`
    .app-container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    .app-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .app-title {
      font-size: 20px;
      font-weight: 600;
      color: #1B4F72;
      margin: 0;
    }
    .settings-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      transition: background 0.15s;
    }
    .settings-btn:hover {
      background: #f3f4f6;
      border-color: #d1d5db;
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

  // Token management
  showTokenSetup = false;
  showTokenSettings = false;
  showSettingsGear = false;
  tokenUrls: Record<string, string> = {};

  // URL search state
  urlSearchResults: TraceMatch[] = [];
  urlSearchLimitReached = false;
  selectedTraceId: string | null = null;
  private lastUrlSearchTimeframe: Timeframe | null = null;

  // Session search state
  sessionEvents: UserEventRecord[] = [];
  tracesFromSessionUrl: string | null = null;
  lastSearchMode: 'trace' | 'request' | 'url' | 'session' | null = null;

  constructor(
    private dynatraceService: DynatraceService,
    private configService: ConfigService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit(): Promise<void> {
    await this.configService.load();
    this.envHostnamePatterns = this.configService.getEnvHostnamePatterns();
    this.environments = this.configService.getEnvironments();
    this.tokenUrls = this.configService.getTokenUrls();

    // Always default to Non-Prod every session, regardless of what's available.
    const nonProd = this.environments.find(e => !e.isProd);
    this.environment = nonProd ? nonProd.id : (this.environments[0]?.id || 'NON-PROD');
    this.configLoaded = true;

    // Token setup: if individual user tokens are enabled, check if the
    // required (non-prod) token exists. If not, show the setup modal.
    if (this.configService.isIndividualUserToken()) {
      this.showSettingsGear = true;
      const requiredEnvId = nonProd?.id || 'NON-PROD';
      if (!DynatraceService.getStoredToken(requiredEnvId)) {
        this.showTokenSetup = true;
      }
    }

    // Force a change detection pass — without this, the env-row may not
    // render until a user interaction triggers CD (zone.js timing issue).
    this.cdr.detectChanges();
  }

  /** Non-prod environments only — used for the first-time setup modal */
  get nonProdEnvironments(): EnvironmentOption[] {
    return this.environments.filter(e => !e.isProd);
  }

  isProd(): boolean {
    const current = this.environments.find(e => e.id === this.environment);
    return !!current?.isProd;
  }

  currentEnvLabel(): string {
    return this.environments.find(e => e.id === this.environment)?.label || this.environment;
  }

  // ── Token modal handlers ───────────────────────────────────────────

  openSettings(): void {
    this.showTokenSettings = true;
  }

  onTokenSetupDone(): void {
    this.showTokenSetup = false;
    this.cdr.detectChanges();
  }

  onTokenSettingsDone(): void {
    this.showTokenSettings = false;
    this.cdr.detectChanges();
  }

  // ── Search handlers ────────────────────────────────────────────────

  onSearch(event: SearchEvent): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.spans = [];
    this.resolvedFromRequestId = null;
    this.urlSearchResults = [];
    this.urlSearchLimitReached = false;
    this.selectedTraceId = null;
    this.lastUrlSearchTimeframe = null;
    this.sessionEvents = [];
    this.tracesFromSessionUrl = null;
    this.lastSearchMode = event.mode;

    if (event.mode === 'trace') {
      this.fetchTrace(event.value, event.timeframe);
      return;
    }

    if (event.mode === 'url') {
      this.lastUrlSearchTimeframe = event.timeframe;
      this.dynatraceService.searchByUrl(event.value, this.environment, event.timeframe).subscribe({
        next: (response) => {
          this.urlSearchResults = response.results || [];
          this.urlSearchLimitReached = this.urlSearchResults.length >= 100;
          if (this.urlSearchResults.length === 0) {
            this.errorMsg = 'No traces found for that URL in the selected time window.';
          }
          this.isLoading = false;
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to search by URL. Please try again.';
          this.isLoading = false;
        }
      });
      return;
    }

    if (event.mode === 'session') {
      this.lastUrlSearchTimeframe = event.timeframe;
      this.dynatraceService.fetchSession(event.value, this.environment, event.timeframe).subscribe({
        next: (response) => {
          this.sessionEvents = response.events || [];
          if (this.sessionEvents.length === 0) {
            this.errorMsg = 'No events found for that session ID in the selected time window. Try widening the time window.';
          }
          this.isLoading = false;
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to fetch session data. Please try again.';
          this.isLoading = false;
        }
      });
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

  /**
   * Triggered when the user clicks "Find backend traces" on a user action
   * inside the session view. Fires a URL search using the action's full URL
   * and populates the URL results table. Preserves the session view above.
   *
   * Narrows the search in two ways that regular URL search does not:
   *  1. Time window: ±2 minutes around the event's actual start time,
   *     overriding the user's global selection. Even a 5-day time window
   *     becomes a 4-minute window, cutting ~1000x noise.
   *  2. Host exact match: we know the fully qualified hostname from the
   *     event, so we don't want cross-environment matches.
   */
  onFindBackendTraces(payload: { urlFull: string; eventStartTime: string }): void {
    const { urlFull, eventStartTime } = payload;
    if (!urlFull) return;

    this.tracesFromSessionUrl = urlFull;
    this.urlSearchResults = [];
    this.urlSearchLimitReached = false;
    this.selectedTraceId = null;
    this.spans = [];
    this.errorMsg = '';

    const timeframe = this.buildNarrowTimeframe(eventStartTime);

    this.dynatraceService.searchByUrl(urlFull, this.environment, timeframe, true).subscribe({
      next: (response) => {
        this.urlSearchResults = response.results || [];
        this.urlSearchLimitReached = this.urlSearchResults.length >= 100;
        if (this.urlSearchResults.length === 0) {
          this.errorMsg = 'No backend traces found for this URL within ±2 minutes of the session event.';
        }
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to search backend traces. Please try again.';
      }
    });
  }

  /**
   * Builds a tight ±2 minute timeframe centered on the given event time.
   * Falls back to a last-2-hours window if the event time is missing or
   * unparseable so the search still runs.
   */
  private buildNarrowTimeframe(eventStartTime: string): Timeframe {
    const WINDOW_MS = 2 * 60 * 1000;   // 2 minutes either side
    const FALLBACK_MS = 2 * 60 * 60 * 1000;  // last 2 hours

    const eventMs = eventStartTime ? new Date(eventStartTime).getTime() : NaN;
    if (!eventStartTime || isNaN(eventMs)) {
      const now = Date.now();
      return {
        from: new Date(now - FALLBACK_MS).toISOString(),
        to: new Date(now).toISOString()
      };
    }

    return {
      from: new Date(eventMs - WINDOW_MS).toISOString(),
      to: new Date(eventMs + WINDOW_MS).toISOString()
    };
  }

  /**
   * Handles clicking a row in the trace results table. Loads the selected
   * trace into the existing trace-results view below.
   */
  onUrlResultClick(result: TraceMatch): void {
    this.selectedTraceId = result.traceId;
    // Reuse the same timeframe that was used for the URL search so the
    // trace fetch targets the same window the user was exploring.
    const timeframe = this.lastUrlSearchTimeframe || {
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString()
    };
    this.fetchTrace(result.traceId, timeframe);
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
