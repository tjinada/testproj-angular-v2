/** Search mode: by trace ID directly, by request ID (resolved to a trace ID), by full URL, by RUM session ID, by client IP request attribute, by endpoint (unique URLs for attestation), or by components (all flow-diagram components touched by an exact url.path) */
export type SearchMode = 'trace' | 'request' | 'url' | 'session' | 'clientIp' | 'endpoint' | 'components';

/** A single trace match returned by a search (URL, hotspot, service, etc.) */
export interface TraceMatch {
  traceId: string;
  startTime: string;
  endpoint: string;
  service: string;
  serverAddress: string;
  httpStatus: string;
  isFailed: boolean;
  hasExceptions: boolean;
  exceptionCount: number;
  duration: number;
}

/** A unique endpoint (method + URL path pair) returned by the endpoint
 *  search. Used to attest whether an endpoint sees traffic in a given
 *  environment. Sorted server-side alphabetically by path, then method. */
export interface EndpointMatch {
  method: string;
  urlPath: string;
  service: string;
  serverAddress: string;
  count: number;
  lastSeen: string;
}

/** A deduped component row from the components-by-URL search. Derived
 *  client-side by running buildFlowGraph() over the sampled spans — one
 *  row per flow-diagram box, including synthetic external/DB nodes
 *  (which carry no spans, so traceCount/spanCount are 0 for them). */
export interface ComponentRow {
  id: string;            // FlowNode.id — unique (name, or ext:/db: prefixed)
  name: string;          // FlowNode.label
  type: string;          // Database | External | Lambda | WebSphere | Channels | Kubernetes | Service
  hostname: string;      // short host/container line
  fullHostname: string;  // full value for tooltip
  isSynthetic: boolean;
  traceCount: number;
  spanCount: number;
}

/** Raw user.events record from Dynatrace. Fields are loose because the
 *  Grail RUM schema varies by event kind and agent config; the analyzer
 *  guards every access. */
export interface UserEventRecord {
  [key: string]: unknown;
}

/** One-time session-level metadata extracted from any event in the session. */
export interface SessionSummary {
  sessionId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  browser: string;
  os: string;
  deviceType: string;
  country: string;
  clientIp: string;
  isp: string;
  appName: string;
  pageViewCount: number;
  userActionCount: number;
  errorCount: number;
}

/** Union kind for a single non-page-view event inside a page group. */
export type SessionEventKind = 'user_action' | 'error' | 'request';

/** A single non-page-view event inside a page group. */
export interface SessionEvent {
  kind: SessionEventKind;
  startTime: string;
  relativeMs: number;      // ms offset from session start
  durationNanos: number;
  label: string;           // human-readable summary
  isFailed: boolean;
  urlFull: string;          // for user_action — used by "Find backend traces"
  httpStatus: string;
  raw: UserEventRecord;    // retained for the detail panel
}

/** A page view and everything that happened on it. */
export interface SessionPageGroup {
  pageName: string;
  pageTitle: string;
  pageUrlFull: string;
  startTime: string;
  relativeMs: number;
  durationNanos: number;
  webVitals: {
    lcp: string;
    fcp: string;
    fid: string;
    cls: string;
    clsValue: string;
    inpDurationMs: number;
  };
  errorCounts: {
    http4xx: number;
    http5xx: number;
    exception: number;
    cspViolation: number;
  };
  events: SessionEvent[];
}

/** A preset time window option for search queries */
export interface TimeWindow {
  /** Unique identifier (e.g. '2h', '1d') */
  id: string;
  /** Display label (e.g. 'Last 2 hours') */
  label: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/** Absolute timeframe passed to the backend */
export interface Timeframe {
  from: string;
  to: string;
}

/** Raw span record from Dynatrace poll response */
export interface SpanRecord {
  'trace.id': string;
  'span.id': string;
  'span.parent_id': string | null;
  'span.name': string;
  'span.kind': string;
  'span.status_code'?: string;
  'span.source'?: string;
  'start_time': string;
  'end_time': string;
  'duration': string | number;
  'endpoint.name'?: string;
  'dt.entity.service'?: string;
  'dt.service.name'?: string;
  'dt.entity.service.entity.name'?: string;
  'dt.entity.host.entity.name'?: string;
  'dt.entity.process_group.entity.name'?: string;
  'dt.entity.process_group_instance.entity.name'?: string;
  'request.is_failed'?: boolean;
  'request.is_root_span'?: boolean;
  'dt.failure_detection.verdict'?: string;
  'dt.failure_detection.results'?: Array<{
    verdict: string;
    reason: string;
    exception_id: string[];
  }>;
  'http.response.status_code'?: string;
  'http.request.method'?: string;
  'code.call_stack'?: string | null;
  'code.function'?: string;
  'code.namespace'?: string;
  'span.events'?: SpanEvent[] | null;
  'span.is_exit_by_exception'?: boolean;
  'span.exit_by_exception_id'?: string;
  'url.path'?: string;
  'url.full'?: string;
  'server.address'?: string;
  'server.port'?: string;
  'host.name'?: string;
  'k8s.container.name'?: string;
  'websphere.server.name'?: string;
  'websphere.cluster.name'?: string;
  'otel.scope.name'?: string;
  'cloud.provider'?: string;
  'faas.name'?: string;
  'icon'?: { primaryIconType: string; secondaryIconType: string | null } | null;
  [key: string]: unknown;
}

/** Exception event within a span */
export interface SpanEvent {
  'span_event.name': string;
  'exception.type'?: string;
  'exception.message'?: string;
  'exception.id'?: string;
  'exception.escaped'?: boolean;
  'exception.is_caused_by_root'?: boolean;
  'exception.file.full'?: string;
  'exception.line_number'?: string;
  'exception.stack_trace'?: string;
}

/** Dynatrace poll response structure */
export interface DynatraceResponse {
  state: string;
  progress?: number;
  result: {
    records: SpanRecord[];
    types?: unknown[];
  };
}

/** A single step in the error propagation path */
export interface ErrorPathStep {
  service: string;
  urlPath: string;
  isFailedCall?: boolean;
  serverAddress?: string;
  httpStatus?: string;
}

/** Processed error summary for display */
export interface ErrorSummary {
  component: string;
  endpoint: string;
  environment: string;
  httpStatus: string;
  httpStatusText: string;
  errorPath: ErrorPathStep[];
  errorMessage: string;
  stackTrace: string;
  timestamp: string;
}

/** Processed success summary for display (trace succeeded overall) */
export interface SuccessSummary {
  component: string;       // root service name
  endpoint: string;        // root endpoint.name
  environment: string;
  httpStatus: string;       // e.g. "200"
  duration: string;         // formatted duration string (e.g. "4.27s")
  spanCount: number;
  timestamp: string;
}

/**
 * A captured exception found inside a span's span.events. Surfaced
 * regardless of whether the span itself is considered failed — used to
 * show handled exceptions on otherwise-successful spans (e.g. a 200
 * response that internally caught and recorded an exception).
 */
export interface CapturedException {
  spanId: string;
  service: string;
  endpoint: string;
  httpStatus: string;
  exceptionType: string;
  exceptionMessage: string;
  stackTrace: string;
}

/** Processed span for call flow display */
export interface CallFlowSpan {
  spanId: string;
  parentSpanId: string | null;
  serviceName: string;
  endpointName: string;
  httpStatus: string;
  duration: number;
  startTime: string;
  spanKind: string;
  isError: boolean;
}
