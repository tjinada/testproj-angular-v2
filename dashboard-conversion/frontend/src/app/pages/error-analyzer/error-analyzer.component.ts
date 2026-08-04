import { Component, OnInit, ChangeDetectorRef, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SearchComponent, SearchEvent, SearchSeed } from './components/search/search.component';
import { TraceResultsComponent } from './components/trace-results/trace-results.component';
import { TraceResultsTableComponent } from './components/trace-results-table/trace-results-table.component';
import { SessionResultsComponent } from './components/session-results/session-results.component';
import { TokenSetupComponent } from './components/token-setup/token-setup.component';
import { OpenSearchLogSearchComponent } from './components/opensearch-log-search/opensearch-log-search.component';
import { EndpointResultsTableComponent } from './components/endpoint-results-table/endpoint-results-table.component';
import { ComponentResultsTableComponent } from './components/component-results-table/component-results-table.component';
import { CallerResultsTableComponent } from './components/caller-results-table/caller-results-table.component';
import { TrafficFlowComponent } from './components/traffic-flow/traffic-flow.component';
import { DashboardLinksComponent } from './components/dashboard-links/dashboard-links.component';
import { buildFlowGraph, FlowNode } from './components/flow-diagram/flow-layout';
import { DynatraceService } from './services/dynatrace.service';
import { ConfigService, DashboardLink, EnvironmentOption } from './services/config.service';
import { CallerRow, ComponentRow, EndpointMatch, SearchMode, SpanRecord, Timeframe, TraceMatch, UserEventRecord } from './models/trace.model';

type TabId = 'trace' | 'opensearch' | 'traffic' | 'monitoring';

@Component({
  selector: 'app-error-analyzer',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchComponent, TraceResultsComponent, TraceResultsTableComponent, SessionResultsComponent, TokenSetupComponent, OpenSearchLogSearchComponent, EndpointResultsTableComponent, ComponentResultsTableComponent, CallerResultsTableComponent, TrafficFlowComponent, DashboardLinksComponent],
  templateUrl: './error-analyzer.component.html',
  styleUrls: ['./error-analyzer.component.scss']
})
export class ErrorAnalyzerComponent implements OnInit {
  /** Anchor wrapping the trace detail (summary card + flow diagram) for auto-scroll. */
  @ViewChild('traceDetailAnchor') traceDetailAnchor?: ElementRef<HTMLElement>;

  /** Used to run a seeded search once config and environment are resolved. */
  @ViewChild(SearchComponent) searchRef?: SearchComponent;

  spans: SpanRecord[] = [];
  isLoading = false;
  /** True only while a trace detail fetch is in flight; drives the detail skeleton. */
  isTraceLoading = false;
  errorMsg = '';
  environment = 'NON-PROD';
  environments: EnvironmentOption[] = [];
  envHostnamePatterns: string[] = [];
  resolvedFromRequestId: { traceId: string; requestId: string } | null = null;
  configLoaded = false;

  // Tab state
  activeTab: TabId = 'trace';

  /** Query params handed to the Traffic Flow tab so shared scenario links restore. */
  trafficParams: Record<string, string> | null = null;

  /** Pre-fill for the search bar built from a shared trace link (?trace_id=...). */
  searchSeed: SearchSeed | null = null;

  // CDB Monitoring tab (YAML-driven dashboard links)
  dashboards: DashboardLink[] = [];
  dashboardAccessRequestUrl: string | null = null;

  // Token management
  showTokenSetup = false;
  showTokenSettings = false;
  showSettingsGear = false;
  tokenUrls: Record<string, string> = {};

  // URL search state
  urlSearchResults: TraceMatch[] = [];
  urlSearchLimitReached = false;
  isLoadingMoreTraces = false;
  selectedTraceId: string | null = null;
  private lastUrlSearchTimeframe: Timeframe | null = null;
  private lastTraceSearch: { mode: 'url' | 'clientIp'; value: string; hostExact: boolean; timeframe: Timeframe } | null = null;

  // Endpoint search state
  endpointResults: EndpointMatch[] = [];
  endpointLimitReached = false;

   // Component search state
  componentResults: ComponentRow[] = [];
  componentTracesAnalyzed = 0;
  componentTracesRequested = 0;

  // Caller search state (per clicked component row)
  callerResults: CallerRow[] = [];
  callerComponentName = '';
  callerTracesAnalyzed = 0;
  callerTracesRequested = 0;
  callerTracesWithRoot = 0;


  // Session search state
  sessionEvents: UserEventRecord[] = [];
  tracesFromSessionUrl: string | null = null;
  lastSearchMode: SearchMode | null = null;

  constructor(
    private dynatraceService: DynatraceService,
    private configService: ConfigService,
    private cdr: ChangeDetectorRef,
    private router: Router
  ) {}

  async ngOnInit(): Promise<void> {
    // Read before the first await: the Traffic Flow child is created during the
    // parent's first change detection, so its input must already be set.
    const qp = this.router.parseUrl(this.router.url).queryParams as Record<string, string>;
    if (qp && Object.keys(qp).length > 0) {
      this.trafficParams = qp;
      if (qp['tab'] === 'traffic') {
        this.activeTab = 'traffic';
      }
    }

    // Shared trace link. The search bar validates the window id and falls back
    // to its own default when the param is missing or unknown.
    const traceId = (qp?.['trace_id'] ?? '').trim();
    if (traceId) {
      this.searchSeed = { mode: 'trace', value: traceId, windowId: qp['win'] ?? '' };
    }

    await this.configService.load();
    this.envHostnamePatterns = this.configService.getEnvHostnamePatterns();
    this.environments = this.configService.getEnvironments();
    this.tokenUrls = this.configService.getTokenUrls();
    this.dashboards = this.configService.getDashboards();
    this.dashboardAccessRequestUrl = this.configService.getDashboardAccessRequestUrl();

    const nonProd = this.environments.find(e => !e.isProd);
    this.environment = nonProd ? nonProd.id : (this.environments[0]?.id || 'NON-PROD');

    // An ?env= from a shared link wins, but only if the config knows it.
    const linkedEnv = this.environments.find(e => e.id === qp?.['env']);
    if (linkedEnv) {
      this.environment = linkedEnv.id;
    }

    this.configLoaded = true;

    if (this.configService.isIndividualUserToken()) {
      this.showSettingsGear = true;
      const requiredEnvId = nonProd?.id || 'NON-PROD';
      if (!DynatraceService.getStoredToken(requiredEnvId)) {
        this.showTokenSetup = true;
      }
    }

    this.cdr.detectChanges();

    // detectChanges above creates the search bar, so searchRef is now resolved.
    // Blocked by the token modal: the fields stay seeded and the user is one
    // click away once a token is saved.
    if (this.searchSeed && !this.showTokenSetup) {
      this.searchRef?.submitSeed();
    }
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

  onTokenSetupClosed(): void {
    this.showTokenSetup = false;
    this.cdr.detectChanges();
    this.router.navigate(['/envs-dashboard']);
  }

  onTokenSettingsDone(): void {
    this.showTokenSettings = false;
    this.cdr.detectChanges();
  }

  // ── Search handlers ────────────────────────────────────────────────

  /**
   * Keeps the address bar shareable for trace-ID searches. Any other mode
   * clears the params rather than leaving a stale trace_id behind. Custom
   * time ranges are not shareable, so win is omitted for them. This is a
   * full param replace, so it also clears any Traffic Flow scenario params.
   */
  private syncUrl(event: SearchEvent): void {
    const queryParams = event.mode === 'trace'
      ? {
          trace_id: event.value,
          env: this.environment,
          win: event.windowId === 'custom' ? null : event.windowId
        }
      : {};

    this.router.navigate([], { queryParams, replaceUrl: true });
  }

  onSearch(event: SearchEvent): void {
    this.isLoading = true;
    this.isTraceLoading = false;
    this.errorMsg = '';
    this.spans = [];
    this.resolvedFromRequestId = null;
    this.urlSearchResults = [];
    this.urlSearchLimitReached = false;
    this.isLoadingMoreTraces = false;
    this.lastTraceSearch = null;
    this.selectedTraceId = null;
    this.lastUrlSearchTimeframe = null;
    this.endpointResults = [];
    this.endpointLimitReached = false;
    this.componentResults = [];
    this.componentTracesAnalyzed = 0;
    this.componentTracesRequested = 0;
    this.clearCallerResults();
    this.sessionEvents = [];
    this.tracesFromSessionUrl = null;
    this.lastSearchMode = event.mode;
    this.syncUrl(event);

    if (event.mode === 'trace') {
      this.isTraceLoading = true;
      this.fetchTrace(event.value, event.timeframe);
      return;
    }

    if (event.mode === 'url') {
      this.lastUrlSearchTimeframe = event.timeframe;
      this.lastTraceSearch = { mode: 'url', value: event.value, hostExact: false, timeframe: event.timeframe };
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
      this.lastUrlSearchTimeframe = event.timeframe;
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

    if (event.mode === 'components') {
      this.lastUrlSearchTimeframe = event.timeframe;
      this.dynatraceService.searchComponents(event.value.trim(), this.environment, event.timeframe).subscribe({
        next: (response) => {
          this.componentTracesAnalyzed = response.tracesAnalyzed;
          this.componentTracesRequested = response.tracesRequested;
          this.componentResults = this.buildComponentRows(response.records || []);
          if (this.componentTracesAnalyzed === 0) {
            this.errorMsg = 'No traces with an HTTP 200 response found for that exact url.path in the selected time window.';
          }
          this.isLoading = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.errorMsg = err.error?.error || 'Failed to search components. Please try again.';
          this.isLoading = false;
          this.cdr.detectChanges();
        }
      });
      return;
    }

    if (event.mode === 'clientIp') {
      this.lastUrlSearchTimeframe = event.timeframe;
      this.lastTraceSearch = { mode: 'clientIp', value: event.value, hostExact: false, timeframe: event.timeframe };
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
    this.isTraceLoading = true;
    this.dynatraceService.lookupTraceIdByRequestId(requestId, this.environment, event.timeframe).subscribe({
      next: (response) => {
        this.resolvedFromRequestId = { traceId: response.traceId, requestId: response.requestId };
        this.fetchTrace(response.traceId, event.timeframe);
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to look up request ID. Please try again.';
        this.isLoading = false;
        this.isTraceLoading = false;
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

   onLoadMoreTraces(): void {
    if (!this.lastTraceSearch || this.isLoadingMoreTraces || this.urlSearchResults.length === 0) return;

    const oldestMs = Math.min(...this.urlSearchResults.map(r => new Date(r.startTime).getTime()));
    if (!Number.isFinite(oldestMs)) return;

    const search = this.lastTraceSearch;
    const cursorTimeframe: Timeframe = { from: search.timeframe.from, to: new Date(oldestMs).toISOString() };

    this.isLoadingMoreTraces = true;
    this.errorMsg = '';

    const request$ = search.mode === 'clientIp'
      ? this.dynatraceService.searchByClientIp(search.value, this.environment, cursorTimeframe)
      : this.dynatraceService.searchByUrl(search.value, this.environment, cursorTimeframe, search.hostExact);

    request$.subscribe({
      next: (response) => {
        const incoming = response.results || [];
        const known = new Set(this.urlSearchResults.map(r => r.traceId));
        const fresh = incoming.filter(r => !known.has(r.traceId));
        this.urlSearchResults = [...this.urlSearchResults, ...fresh];
        // A full page means more may exist; a short page means the window is
        // exhausted. A full page of pure duplicates would loop forever, so
        // treat zero fresh rows as exhausted too.
        this.urlSearchLimitReached = incoming.length >= 100 && fresh.length > 0;
        this.isLoadingMoreTraces = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to load more traces. Please try again.';
        this.isLoadingMoreTraces = false;
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
    this.isTraceLoading = true;
    this.errorMsg = '';
    this.spans = [];
    this.scrollToTraceDetail();
    const timeframe = this.lastUrlSearchTimeframe || {
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString()
    };
    this.fetchTrace(result.traceId, timeframe);
  }

  onEndpointLatestTrace(row: EndpointMatch): void {
    this.isLoading = true;
    this.isTraceLoading = true;
    this.errorMsg = '';
    this.spans = [];
    this.selectedTraceId = null;
    this.scrollToTraceDetail();

    const timeframe = this.lastUrlSearchTimeframe || {
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString()
    };

    this.dynatraceService.findLatestTraceForEndpoint(row.urlPath, row.method, this.environment, timeframe).subscribe({
      next: (response) => {
        this.selectedTraceId = response.traceId;
        this.fetchTrace(response.traceId, timeframe);
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to find the latest trace for this endpoint.';
        this.isLoading = false;
        this.isTraceLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private clearCallerResults(): void {
    this.callerResults = [];
    this.callerComponentName = '';
    this.callerTracesAnalyzed = 0;
    this.callerTracesRequested = 0;
    this.callerTracesWithRoot = 0;
  }

  onCallerTraceClick(traceId: string): void {
    this.selectedTraceId = traceId;
    this.isLoading = true;
    this.isTraceLoading = true;
    this.errorMsg = '';
    this.spans = [];
    this.scrollToTraceDetail();
    const timeframe = this.lastUrlSearchTimeframe || {
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString()
    };
    this.fetchTrace(traceId, timeframe);
  }

  /**
   * "Find callers" on a component row: samples recent traces containing
   * the component (any URL) and lists the deduped root/entry apps that
   * called it. Reuses the time window of the components search.
   */
  onFindCallers(row: ComponentRow): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.clearCallerResults();
    this.spans = [];
    this.selectedTraceId = null;
    const timeframe = this.lastUrlSearchTimeframe || {
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString()
    };

    const target = row.syntheticKey || row.name;
    const kind = row.syntheticKind || 'service';

    this.dynatraceService.searchCallers(target, this.environment, timeframe, kind).subscribe({
      next: (response) => {
        this.callerComponentName = row.name;
        this.callerResults = response.callers || [];
        this.callerTracesAnalyzed = response.tracesAnalyzed;
        this.callerTracesRequested = response.tracesRequested;
        this.callerTracesWithRoot = response.tracesWithRoot;
        if (response.tracesAnalyzed === 0) {
          this.errorMsg = 'No traces containing this component found in the selected time window.';
          this.callerComponentName = '';
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to search callers. Please try again.';
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private buildComponentRows(records: SpanRecord[]): ComponentRow[] {
    if (records.length === 0) return [];
    const nodes = buildFlowGraph(records).nodes;
    return nodes
      .map(n => ({
        id: n.id,
        name: n.label,
        type: this.componentType(n),
        hostname: n.hostname,
        fullHostname: n.fullHostname,
        isSynthetic: n.isExternal,
        syntheticKind: n.isDb ? 'db' as const : (n.isExternal ? 'external' as const : null),
        syntheticKey: n.isDb
          ? n.id.slice('db:'.length)
          : (n.isExternal ? n.id.slice('ext:'.length) : null),
        traceCount: new Set(n.spans.map(s => s['trace.id'])).size,
        spanCount: n.spanCount
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Single display type per node, most specific flag first. */
  private componentType(n: FlowNode): string {
    if (n.isDb) return 'Database';
    if (n.isExternal) return 'External';
    if (n.isLambda) return 'Lambda';
    if (n.isWebSphere) return 'WebSphere';
    if (n.isChannels) return 'Channels';
    if (n.spans.some(s => !!s['k8s.container.name'])) return 'Kubernetes';
    return 'Service';
  }

  /**
   * Scrolls the viewport to the Component Flow diagram. Called when a
   * trace fetch starts: while loading it targets the diagram's skeleton
   * placeholder, after load the real diagram sits in (roughly) the same
   * spot. Falls back to the anchor top if neither element exists yet.
   * detectChanges first so the skeleton exists before scrolling; the
   * setTimeout lets the browser finish layout in the same frame.
   */
  private scrollToTraceDetail(): void {
    this.cdr.detectChanges();
    setTimeout(() => {
      const anchor = this.traceDetailAnchor?.nativeElement;
      if (!anchor) return;
      const target = anchor.querySelector('.skeleton-diagram, app-flow-diagram') as HTMLElement | null;
      const top = (target || anchor).getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top, behavior: 'smooth' });
    }, 0);
  }

  private fetchTrace(traceId: string, timeframe: Timeframe): void {
    this.dynatraceService.fetchTrace(traceId, this.environment, timeframe).subscribe({
      next: (response) => {
        this.spans = response.result?.records || [];
        if (this.spans.length === 0) {
          this.errorMsg = 'No spans found for this trace ID. Check the trace ID and try again.';
        }
        this.isLoading = false;
        this.isTraceLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to fetch trace data. Please try again.';
        this.isLoading = false;
        this.isTraceLoading = false;
        this.cdr.detectChanges();
      }
    });
  }
}