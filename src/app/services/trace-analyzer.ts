import { SpanRecord, ErrorPathStep, CallFlowSpan } from '../models/trace.model';

/**
 * Stateful analyzer for a single Dynatrace trace.
 *
 * Encapsulates all the logic for extracting meaningful information from a
 * set of span records: root cause detection, error path building, HTTP
 * status resolution, and call flow construction. Construct one per trace.
 */
export class TraceAnalyzer {
  private readonly spanMap: Map<string, SpanRecord>;

  constructor(private readonly spans: SpanRecord[]) {
    this.spanMap = new Map();
    spans.forEach(s => this.spanMap.set(s['span.id'], s));
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Finds the root cause span — the deepest span in the call tree that
   * contains the originating exception.
   *
   * Detection priority:
   *   1. Deepest span with exception.is_caused_by_root = true
   *   2. Deepest span with request.is_failed = true
   *   3. Deepest span with any error indicator
   */
  findRootCause(): SpanRecord | null {
    const errorSpans = this.spans.filter(s => this.isErrorSpan(s));
    if (errorSpans.length === 0) return null;
    if (errorSpans.length === 1) return errorSpans[0];

    const rootCauseExceptionSpans = errorSpans.filter(s => this.hasRootCauseException(s));
    if (rootCauseExceptionSpans.length > 0) {
      return this.pickDeepest(rootCauseExceptionSpans);
    }

    const rootFailures = errorSpans.filter(s => s['request.is_failed'] === true);
    if (rootFailures.length > 0) {
      return this.pickDeepest(rootFailures);
    }

    return this.pickDeepest(errorSpans);
  }

  /**
   * Resolves the HTTP status code that corresponds to an error on this span.
   *   1. Direct status on the span
   *   2. Match via Dynatrace's exception_id linking (span.exit_by_exception_id
   *      → dt.failure_detection.results[*].exception_id)
   *   3. Any error span in the same service with an HTTP status
   */
  findHttpStatus(span: SpanRecord): string {
    if (span['http.response.status_code']) {
      return span['http.response.status_code'];
    }

    const exitExceptionId = span['span.exit_by_exception_id'];
    if (exitExceptionId) {
      const linkedSpan = this.spans.find(s => {
        const results = s['dt.failure_detection.results'];
        if (!results || results.length === 0) return false;
        return results.some(r =>
          Array.isArray(r.exception_id) && r.exception_id.includes(exitExceptionId)
        );
      });
      if (linkedSpan && linkedSpan['http.response.status_code']) {
        return linkedSpan['http.response.status_code'];
      }
    }

    const service = this.getServiceName(span);
    if (service) {
      const sameServiceErrorSpan = this.spans.find(s =>
        this.getServiceName(s) === service
        && this.isErrorSpan(s)
        && !!s['http.response.status_code']
      );
      if (sameServiceErrorSpan && sameServiceErrorSpan['http.response.status_code']) {
        return sameServiceErrorSpan['http.response.status_code'];
      }
    }

    return '';
  }

  /**
   * Builds the error propagation path from entry point down to the root
   * cause. Walks the parent chain, prepends the true trace entry point if
   * the chain walk stopped early (e.g., due to a cycle in the raw data),
   * backfills missing URL paths, and appends the failing outbound call.
   */
  buildErrorPath(): ErrorPathStep[] {
    const rootCause = this.findRootCause();
    if (!rootCause) return [];

    const chain = this.walkParentChain(rootCause);
    this.prependEntryPointIfMissing(chain);

    const steps = this.groupChainByService(chain);
    this.backfillMissingUrlPaths(steps);
    this.appendFailingOutboundCall(steps);

    return steps;
  }

  /**
   * Builds a flat, time-sorted list of spans for the call flow display.
   */
  buildCallFlow(): CallFlowSpan[] {
    return [...this.spans]
      .sort((a, b) => new Date(a['start_time']).getTime() - new Date(b['start_time']).getTime())
      .map(span => ({
        spanId: span['span.id'],
        parentSpanId: span['span.parent_id'],
        serviceName: this.getServiceName(span) || 'Unknown',
        endpointName: span['endpoint.name'] || '',
        httpStatus: span['http.response.status_code'] || '',
        duration: Number(span['duration']) || 0,
        startTime: span['start_time'],
        spanKind: span['span.kind'] || '',
        isError: this.isErrorSpan(span)
      }));
  }

  /**
   * Derives the environment by collecting unique server hostnames from all
   * spans, stripping common domain suffixes.
   */
  deriveEnvironment(fallback: string): string {
    const addresses = new Set<string>();
    this.spans.forEach(span => {
      const addr = span['server.address'];
      if (addr) addresses.add(this.cleanHostname(addr));
    });

    if (addresses.size === 0) return fallback;
    return Array.from(addresses).join(', ');
  }

  /**
   * Strips known domain suffixes from a hostname.
   */
  cleanHostname(hostname: string): string {
    const suffixes = ['.bmogc.net', '.srv.bmogc.net'];
    for (const suffix of suffixes) {
      if (hostname.endsWith(suffix)) return hostname.slice(0, -suffix.length);
    }
    return hostname;
  }

  // ------------------------------------------------------------------
  // Private helpers — span predicates
  // ------------------------------------------------------------------

  private getServiceName(span: SpanRecord): string {
    return span['dt.entity.service.entity.name'] || span['dt.service.name'] || '';
  }

  private isErrorSpan(span: SpanRecord): boolean {
    return span['request.is_failed'] === true
      || span['dt.failure_detection.verdict'] === 'failure'
      || span['span.status_code'] === 'error';
  }

  private hasRootCauseException(span: SpanRecord): boolean {
    const events = span['span.events'];
    if (!events || events.length === 0) return false;
    return events.some(e =>
      e['span_event.name'] === 'exception' && e['exception.is_caused_by_root'] === true
    );
  }

  // ------------------------------------------------------------------
  // Private helpers — tree traversal
  // ------------------------------------------------------------------

  private calculateDepth(span: SpanRecord): number {
    let depth = 0;
    let current: SpanRecord | undefined = span;
    const visited = new Set<string>();

    while (current && !visited.has(current['span.id'])) {
      visited.add(current['span.id']);
      const parentId: string | null = current['span.parent_id'];
      if (!parentId) break;
      const parent = this.spanMap.get(parentId);
      if (!parent) break;
      depth++;
      current = parent;
    }
    return depth;
  }

  private pickDeepest(candidates: SpanRecord[]): SpanRecord {
    return candidates
      .map(s => ({ span: s, depth: this.calculateDepth(s) }))
      .sort((a, b) => {
        if (b.depth !== a.depth) return b.depth - a.depth;
        return new Date(b.span['start_time']).getTime() - new Date(a.span['start_time']).getTime();
      })[0].span;
  }

  /**
   * Walks up the parent chain from a span. Returns the chain in entry-point
   * → root-cause order (reversed from the walk direction). Cycle-safe.
   */
  private walkParentChain(start: SpanRecord): SpanRecord[] {
    const chain: SpanRecord[] = [];
    let current: SpanRecord | undefined = start;
    const visited = new Set<string>();

    while (current && !visited.has(current['span.id'])) {
      visited.add(current['span.id']);
      chain.push(current);
      const parentId: string | null = current['span.parent_id'];
      current = parentId ? this.spanMap.get(parentId) : undefined;
    }

    return chain.reverse();
  }

  // ------------------------------------------------------------------
  // Private helpers — error path construction
  // ------------------------------------------------------------------

  /**
   * If the top of the chain isn't a trace entry point (meaning the walk was
   * cut short by a cycle), find an entry-point span in a different service
   * and prepend it. Mutates the chain in place.
   */
  private prependEntryPointIfMissing(chain: SpanRecord[]): void {
    const topOfChain = chain[0];
    if (!topOfChain) return;

    const topParentId = topOfChain['span.parent_id'];
    const topIsEntry = !topParentId || !this.spanMap.has(topParentId);
    if (topIsEntry) return;

    const entryPoints = this.findTraceEntryPoints();
    const topService = this.getServiceName(topOfChain);
    const externalEntry = entryPoints.find(s => this.getServiceName(s) !== topService);
    if (externalEntry) {
      chain.unshift(externalEntry);
    }
  }

  /**
   * Finds server-kind spans whose parent is not in our span set — i.e., the
   * request entered our trace at this span.
   */
  private findTraceEntryPoints(): SpanRecord[] {
    return this.spans.filter(s => {
      if (s['span.kind'] !== 'server') return false;
      const parentId = s['span.parent_id'];
      if (!parentId) return true;
      return !this.spanMap.has(parentId);
    });
  }

  /**
   * Groups a chain of spans by service, keeping the first url.path
   * encountered per service (and upgrading to a better one if a later
   * span in the same service has one).
   */
  private groupChainByService(chain: SpanRecord[]): ErrorPathStep[] {
    const steps: ErrorPathStep[] = [];
    const seenServices = new Set<string>();

    for (const span of chain) {
      const service = this.getServiceName(span);
      if (!service) continue;

      const urlPath = span['url.path'] || '';

      if (seenServices.has(service)) {
        const existing = steps.find(s => s.service === service);
        if (existing && !existing.urlPath && urlPath) {
          existing.urlPath = urlPath;
        }
        continue;
      }

      seenServices.add(service);
      steps.push({ service, urlPath });
    }
    return steps;
  }

  /**
   * For any step with a missing url.path, searches the full trace for any
   * span in that service that has one (preferring server-kind spans).
   */
  private backfillMissingUrlPaths(steps: ErrorPathStep[]): void {
    for (const step of steps) {
      if (!step.urlPath) {
        step.urlPath = this.findUrlPathForService(step.service);
      }
    }
  }

  private findUrlPathForService(serviceName: string): string {
    const serverMatch = this.spans.find(s =>
      this.getServiceName(s) === serviceName
      && s['span.kind'] === 'server'
      && !!s['url.path']
    );
    if (serverMatch && serverMatch['url.path']) return serverMatch['url.path'];

    const anyMatch = this.spans.find(s =>
      this.getServiceName(s) === serviceName && !!s['url.path']
    );
    return anyMatch ? (anyMatch['url.path'] || '') : '';
  }

  /**
   * Appends a "failed calling: ..." step for the downstream outbound HTTP
   * call that failed, unless its URL is already shown in the chain.
   */
  private appendFailingOutboundCall(steps: ErrorPathStep[]): void {
    const urlPathsInChain = new Set(steps.map(s => s.urlPath).filter(Boolean));

    const candidates = this.spans
      .filter(s =>
        s['span.kind'] === 'client'
        && this.isErrorSpan(s)
        && s['server.address']
        && s['url.path']
        && !urlPathsInChain.has(s['url.path'] || '')
      )
      .sort((a, b) => new Date(b['start_time']).getTime() - new Date(a['start_time']).getTime());

    if (candidates.length === 0) return;

    const failingClientSpan = candidates[0];
    steps.push({
      service: this.getServiceName(failingClientSpan),
      urlPath: failingClientSpan['url.path'] || '',
      isFailedCall: true,
      serverAddress: this.cleanHostname(failingClientSpan['server.address'] || ''),
      httpStatus: failingClientSpan['http.response.status_code']
    });
  }
}
