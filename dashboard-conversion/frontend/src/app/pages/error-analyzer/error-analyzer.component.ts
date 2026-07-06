import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchComponent, SearchEvent } from './components/search/search.component';
import { TraceResultsComponent } from './components/trace-results/trace-results.component';
import { TraceResultsTableComponent } from './components/trace-results-table/trace-results-table.component';
import { SessionResultsComponent } from './components/session-results/session-results.component';
import { TokenSetupComponent } from './components/token-setup/token-setup.component';
import { OpenSearchLogSearchComponent } from './components/opensearch-log-search/opensearch-log-search.component';
import { AkamaiFlowComponent } from './components/akamai-flow/akamai-flow.component';
import { UrlTraceComponent } from './components/url-trace/url-trace.component';
import { EndpointResultsTableComponent } from './components/endpoint-results-table/endpoint-results-table.component';
import { DynatraceService } from './services/dynatrace.service';
import { ConfigService, EnvironmentOption } from './services/config.service';
import { EndpointMatch, SearchMode, SpanRecord, Timeframe, TraceMatch, UserEventRecord } from './models/trace.model';

type TabId = 'trace' | 'opensearch' | 'urlTrace' | 'akamai';

@Component({
  selector: 'app-error-analyzer',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchComponent, TraceResultsComponent, TraceResultsTableComponent, SessionResultsComponent, TokenSetupComponent, OpenSearchLogSearchComponent, UrlTraceComponent, AkamaiFlowComponent, EndpointResultsTableComponent],
  templateUrl: './error-analyzer.component.html',
  styleUrls: ['./error-analyzer.component.scss']
})
export class ErrorAnalyzerComponent implements OnInit {
  spans: SpanRecord[] = [];
  isLoading = false;
  errorMsg = '';
  environment = 'NON-PROD';
  environments: EnvironmentOption[] = [];
  envHostnamePatterns: string[] = [];
  resolvedFromRequestId: { traceId: string; requestId: string } | null = null;
  configLoaded = false;

  // Tab state
  activeTab: TabId = 'trace';

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

  // Endpoint search state
  endpointResults: EndpointMatch[] = [];
  endpointLimitReached = false;

  // Session search state
  sessionEvents: UserEventRecord[] = [];
  tracesFromSessionUrl: string | null = null;
  lastSearchMode: SearchMode | null = null;

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

    const nonProd = this.environments.find(e => !e.isProd);
    this.environment = nonProd ? nonProd.id : (this.environments[0]?.id || 'NON-PROD');
    this.configLoaded = true;

    if (this.configService.isIndividualUserToken()) {
      this.showSettingsGear = true;
      const requiredEnvId = nonProd?.id || 'NON-PROD';
      if (!DynatraceService.getStoredToken(requiredEnvId)) {
        this.showTokenSetup = true;
      }
    }

    this.cdr.detectChanges();
  }

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

  // ── Tab handlers ───────────────────────────────────────────────────

  setTab(tab: TabId): void {
    this.activeTab = tab;
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
    this.endpointResults = [];
    this.endpointLimitReached = false;
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
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to search by URL. Please try again.';
          this.isLoading = false;
          this.cdr.detectChanges();
        }
      });
      return;
    }

    if (event.mode === 'endpoint') {
      this.dynatraceService.searchEndpoints(event.value, this.environment, event.timeframe).subscribe({
        next: (response) => {
          this.endpointResults = response.results || [];
          this.endpointLimitReached = this.endpointResults.length >= 500;
          if (this.endpointResults.length === 0) {
            this.errorMsg = 'No endpoints found matching that URL in the selected time window.';
          }
          this.isLoading = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to search endpoints. Please try again.';
          this.isLoading = false;
          this.cdr.detectChanges();
        }
      });
      return;
    }

    if (event.mode === 'clientIp') {
      this.lastUrlSearchTimeframe = event.timeframe;
      this.dynatraceService.searchByClientIp(event.value, this.environment, event.timeframe).subscribe({
        next: (response) => {
          this.urlSearchResults = response.results || [];
          this.urlSearchLimitReached = this.urlSearchResults.length >= 100;
          if (this.urlSearchResults.length === 0) {
            this.errorMsg = 'No traces found for that client IP in the selected time window.';
          }
          this.isLoading = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to search by client IP. Please try again.';
          this.isLoading = false;
          this.cdr.detectChanges();
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
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to fetch session data. Please try again.';
          this.isLoading = false;
          this.cdr.detectChanges();
        }
      });
      return;
    }

    // Request ID mode
    const requestId = event.value;
    this.dynatraceService.lookupTraceIdByRequestId(requestId, this.environment, event.timeframe).subscribe({
      next: (response) => {
        this.resolvedFromRequestId = { traceId: response.traceId, requestId: response.requestId };
        this.fetchTrace(response.traceId, event.timeframe);
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to look up request ID. Please try again.';
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  onFindBackendTraces(payload: { urlFull: string; eventStartTime: string }): void {
    const { urlFull, eventStartTime } = payload;
    if (!urlFull) return;

    this.tracesFromSessionUrl = urlFull;
    this.urlSearchResults = [];
    this.urlSearchLimitReached = false;
    this.selectedTraceId = null;
    this.spans = [];
    this.errorMsg = '';
    this.isLoading = true;

    const timeframe = this.buildNarrowTimeframe(eventStartTime);

    this.dynatraceService.searchByUrl(urlFull, this.environment, timeframe, true).subscribe({
      next: (response) => {
        this.urlSearchResults = response.results || [];
        this.urlSearchLimitReached = this.urlSearchResults.length >= 100;
        if (this.urlSearchResults.length === 0) {
          this.errorMsg = 'No backend traces found for this URL within ±2 minutes of the session event.';
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to search backend traces. Please try again.';
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private buildNarrowTimeframe(eventStartTime: string): Timeframe {
    const WINDOW_MS = 2 * 60 * 1000;
    const FALLBACK_MS = 2 * 60 * 60 * 1000;

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

  onUrlResultClick(result: TraceMatch): void {
    this.selectedTraceId = result.traceId;
    this.isLoading = true;
    this.errorMsg = '';
    this.spans = [];
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
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to fetch trace data. Please try again.';
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }
}
