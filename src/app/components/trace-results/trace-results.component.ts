import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpanRecord, ErrorSummary, CallFlowSpan } from '../../models/trace.model';

@Component({
  selector: 'app-trace-results',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './trace-results.component.html',
  styleUrls: ['./trace-results.component.css']
})
export class TraceResultsComponent {
  @Input() spans: SpanRecord[] = [];
  @Input() isLoading = false;
  @Input() errorMsg = '';
  @Input() environment = 'NON-PROD';

  showMessagePopup = false;
  showStackPopup = false;

  get errorSummary(): ErrorSummary | null {
    if (!this.spans || this.spans.length === 0) return null;

    const failingSpan = this.findRootCauseSpan();
    if (!failingSpan) return null;

    const httpStatus = failingSpan['http.response.status_code'] || '';

    return {
      component: failingSpan['dt.entity.service.entity.name'] || failingSpan['dt.service.name'] || 'Unknown',
      endpoint: failingSpan['endpoint.name'] || failingSpan['span.name'] || 'Unknown',
      environment: this.environment,
      httpStatus,
      httpStatusText: this.getHttpStatusText(httpStatus),
      errorPath: this.buildErrorPropagationPath(),
      errorMessage: this.extractErrorMessage(failingSpan),
      stackTrace: failingSpan['code.call_stack'] || '',
      timestamp: this.formatTimestamp(failingSpan['start_time'])
    };
  }

  get callFlowSpans(): CallFlowSpan[] {
    if (!this.spans || this.spans.length === 0) return [];

    return [...this.spans]
      .sort((a, b) => new Date(a['start_time']).getTime() - new Date(b['start_time']).getTime())
      .map(span => ({
        spanId: span['span.id'],
        parentSpanId: span['span.parent_id'],
        serviceName: span['dt.entity.service.entity.name'] || span['dt.service.name'] || 'Unknown',
        endpointName: span['endpoint.name'] || '',
        httpStatus: span['http.response.status_code'] || '',
        duration: span['duration'] || 0,
        startTime: span['start_time'],
        spanKind: span['span.kind'] || '',
        isError: span['request.status_code'] === 'Failure' || span['span.status_code'] === 'error'
      }));
  }

  formatDuration(nanos: number): string {
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(1)}s`;
  }

  /**
   * Finds the root cause span — the deepest error span in the call chain.
   * Error spans whose span.id is not the parent of any other error span
   * are leaf errors, meaning the error originated there (not propagated).
   */
  private findRootCauseSpan(): SpanRecord | null {
    const errorSpans = this.spans.filter(
      s => s['request.status_code'] === 'Failure' || s['span.status_code'] === 'error'
    );

    if (errorSpans.length === 0) return null;
    if (errorSpans.length === 1) return errorSpans[0];

    // Find leaf errors: error spans that are NOT the parent of another error span
    const errorParentIds = new Set(
      errorSpans.map(s => s['span.parent_id']).filter(Boolean)
    );

    const leafErrors = errorSpans.filter(s => !errorParentIds.has(s['span.id']));

    // If we found leaf errors, pick the one with the latest start_time
    // (in case of multiple independent failures, show the most recent)
    if (leafErrors.length > 0) {
      return leafErrors.sort(
        (a, b) => new Date(b['start_time']).getTime() - new Date(a['start_time']).getTime()
      )[0];
    }

    // Fallback: return the first error span
    return errorSpans[0];
  }

  /**
   * Builds the error propagation path from root cause back to the entry point.
   * Walks up the span parent chain from the root cause span to show how the
   * error propagated through services.
   */
  private buildErrorPropagationPath(): string {
    const rootCause = this.findRootCauseSpan();
    if (!rootCause) return '';

    // Build a lookup map: span.id -> span
    const spanMap = new Map<string, SpanRecord>();
    this.spans.forEach(s => spanMap.set(s['span.id'], s));

    // Walk up the parent chain from root cause to entry point
    const pathParts: string[] = [];
    let current: SpanRecord | undefined = rootCause;
    const visited = new Set<string>();

    while (current && !visited.has(current['span.id'])) {
      visited.add(current['span.id']);

      const service = current['dt.entity.service.entity.name'] || current['dt.service.name'] || '';
      // Only add if it's a different service than the last one added (avoid duplicates)
      if (service && (pathParts.length === 0 || pathParts[pathParts.length - 1] !== service)) {
        pathParts.push(service);
      }

      // Move to parent
      const parentId = current['span.parent_id'];
      current = parentId ? spanMap.get(parentId) : undefined;
    }

    // Reverse so it reads: entry point → ... → root cause
    pathParts.reverse();

    // Append code location from root cause if available
    const codeNs = rootCause['code.namespace'] || '';
    const codeFn = rootCause['code.function'] || '';
    const location = codeNs && codeFn ? ` (${codeNs}.${codeFn})` : '';

    return pathParts.join(' → ') + location;
  }

  private extractErrorMessage(span: SpanRecord): string {
    const events = span['span.events'];
    if (events && events.length > 0) {
      const exception = events.find(e => e['span_event.name'] === 'exception');
      if (exception) {
        const type = exception['exception.type'] || '';
        const msg = exception['exception.message'] || '';
        return type ? `${type}: ${msg}` : msg;
      }
    }
    const stack = span['code.call_stack'];
    if (stack) return stack.split('\n')[0];
    return '';
  }

  private formatTimestamp(ts: string): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  private getHttpStatusText(code: string): string {
    const map: Record<string, string> = {
      '400': 'Bad Request', '401': 'Unauthorized', '403': 'Forbidden',
      '404': 'Not Found', '500': 'Internal Server Error',
      '502': 'Bad Gateway', '503': 'Service Unavailable'
    };
    return map[code] || 'Error';
  }
}
