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

    const failingSpan = this.spans.find(s => s['request.status_code'] === 'Failure')
      || this.spans.find(s => s['span.status_code'] === 'error');

    if (!failingSpan) return null;

    const httpStatus = failingSpan['http.response.status_code'] || '';

    return {
      component: failingSpan['dt.entity.service.entity.name'] || failingSpan['dt.service.name'] || 'Unknown',
      endpoint: failingSpan['endpoint.name'] || failingSpan['span.name'] || 'Unknown',
      environment: this.environment,
      httpStatus,
      httpStatusText: this.getHttpStatusText(httpStatus),
      errorPath: this.buildErrorPath(failingSpan),
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

  private buildErrorPath(span: SpanRecord): string {
    const service = span['dt.entity.service.entity.name'] || span['dt.service.name'] || '';
    const codeNs = span['code.namespace'] || '';
    const codeFn = span['code.function'] || '';
    if (codeNs && codeFn) return `${service} (${codeNs}.${codeFn})`;
    if (span['url.path']) return `${service} (${span['url.path']})`;
    return service;
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
