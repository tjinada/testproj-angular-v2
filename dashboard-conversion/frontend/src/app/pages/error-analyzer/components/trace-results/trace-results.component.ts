import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpanRecord, ErrorSummary, SuccessSummary, CapturedException } from '../../models/trace.model';
import { TraceAnalyzer, extractCapturedExceptions } from '../../services/trace-analyzer';
import { FlowDiagramComponent } from '../flow-diagram/flow-diagram.component';

@Component({
  selector: 'app-trace-results',
  standalone: true,
  imports: [CommonModule, FlowDiagramComponent],
  templateUrl: './trace-results.component.html',
  styleUrls: ['./trace-results.component.scss']
})
export class TraceResultsComponent implements OnChanges {
  @Input() spans: SpanRecord[] = [];
  @Input() isLoading = false;
  @Input() errorMsg = '';
  @Input() environment = 'NON-PROD';
  @Input() envHostnamePatterns: string[] = [];

  showMessagePopup = false;
  showStackPopup = false;
  showCapturedExceptions = false;

  errorSummary: ErrorSummary | null = null;
  successSummary: SuccessSummary | null = null;
  capturedExceptions: CapturedException[] = [];
  rootCauseService: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['spans']) {
      this.analyzeTrace();
    }
  }

  formatDuration(nanos: number): string {
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(1)}s`;
  }

  toggleCapturedExceptions(): void {
    this.showCapturedExceptions = !this.showCapturedExceptions;
  }

  private analyzeTrace(): void {
    if (!this.spans || this.spans.length === 0) {
      this.errorSummary = null;
      this.successSummary = null;
      this.capturedExceptions = [];
      this.rootCauseService = null;
      return;
    }

    const analyzer = new TraceAnalyzer(this.spans, this.envHostnamePatterns);
    this.capturedExceptions = extractCapturedExceptions(this.spans);
    this.showCapturedExceptions = false;

    if (analyzer.isTraceSuccessful()) {
      this.successSummary = this.buildSuccessSummary(analyzer);
      this.errorSummary = null;
      this.rootCauseService = null;
      return;
    }

    this.successSummary = null;
    const rootCause = analyzer.findRootCause();
    this.rootCauseService = analyzer.getRootCauseServiceName();

    if (!rootCause) {
      this.errorSummary = null;
      return;
    }

    const httpStatus = analyzer.findHttpStatus(rootCause);
    this.errorSummary = {
      component: rootCause['dt.entity.service.entity.name'] || rootCause['dt.service.name'] || 'Unknown',
      endpoint: rootCause['endpoint.name'] || rootCause['span.name'] || 'Unknown',
      environment: analyzer.deriveEnvironment(this.environment),
      httpStatus,
      httpStatusText: this.getHttpStatusText(httpStatus),
      errorPath: analyzer.buildErrorPath(),
      errorMessage: this.extractErrorMessage(rootCause),
      stackTrace: this.extractStackTrace(rootCause),
      timestamp: this.formatTimestamp(rootCause['start_time'])
    };
  }

  private buildSuccessSummary(analyzer: TraceAnalyzer): SuccessSummary {
    const root = analyzer.findRootSpan();
    const component =
      (root && (root['dt.entity.service.entity.name'] || root['dt.service.name'])) || 'Unknown';
    const endpoint = (root && (root['endpoint.name'] || root['span.name'])) || 'Unknown';
    const httpStatus = (root && root['http.response.status_code']) || '200';
    const durationNanos = root ? Number(root['duration']) || 0 : 0;

    return {
      component,
      endpoint,
      environment: analyzer.deriveEnvironment(this.environment),
      httpStatus,
      duration: this.formatDuration(durationNanos),
      spanCount: this.spans.length,
      timestamp: root ? this.formatTimestamp(root['start_time']) : ''
    };
  }

  private extractErrorMessage(span: SpanRecord): string {
    const events = span['span.events'];
    if (events && events.length > 0) {
      const rootException = events.find(
        e => e['span_event.name'] === 'exception' && e['exception.is_caused_by_root']
      );
      const exception = rootException || events.find(e => e['span_event.name'] === 'exception');

      if (exception) {
        const type = exception['exception.type'] || '';
        const msg = exception['exception.message'] || '';
        if (type && msg) return `${type}: ${msg}`;
        return type || msg || '';
      }
    }

    const stack = span['code.call_stack'];
    if (stack) return stack.split('\n')[0];
    return '';
  }

  private extractStackTrace(span: SpanRecord): string {
    if (span['code.call_stack']) return span['code.call_stack'];

    const events = span['span.events'];
    if (events && events.length > 0) {
      const withStack = events.find(e => e['exception.stack_trace']);
      if (withStack) return withStack['exception.stack_trace'] || '';
    }

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
