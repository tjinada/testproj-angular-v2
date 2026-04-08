/** Search mode: by trace ID directly, or by request ID (which is then resolved to a trace ID) */
export type SearchMode = 'trace' | 'request';

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
