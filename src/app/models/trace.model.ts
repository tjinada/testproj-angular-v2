/** Raw span record from Dynatrace poll response */
export interface SpanRecord {
  'trace.id': string;
  'span.id': string;
  'span.parent_id': string | null;
  'span.name': string;
  'span.kind': string;
  'span.status_code': string;
  'span.source': string;
  'start_time': string;
  'end_time': string;
  'duration': number;
  'endpoint.name': string;
  'dt.entity.service': string;
  'dt.service.name': string;
  'dt.entity.service.entity.name': string;
  'dt.entity.host.entity.name': string;
  'dt.entity.process_group.entity.name': string;
  'dt.entity.process_group_instance.entity.name': string;
  'request.status_code': string;
  'http.response.status_code': string;
  'code.call_stack': string | null;
  'span.events': SpanEvent[] | null;
  'url.path': string;
  'url.full': string;
  'server.address': string;
  'server.port': string;
  'code.function': string;
  'code.namespace': string;
  'icon': { primaryIconType: string; secondaryIconType: string | null } | null;
}

/** Exception event within a span */
export interface SpanEvent {
  'span_event.name': string;
  'exception.type'?: string;
  'exception.message'?: string;
}

/** Dynatrace poll response structure */
export interface DynatraceResponse {
  state: string;
  result: {
    records: SpanRecord[];
    types: unknown[];
  };
}

/** Processed error summary for display */
export interface ErrorSummary {
  component: string;
  endpoint: string;
  environment: string;
  httpStatus: string;
  httpStatusText: string;
  errorPath: string;
  errorMessage: string;
  stackTrace: string;
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
