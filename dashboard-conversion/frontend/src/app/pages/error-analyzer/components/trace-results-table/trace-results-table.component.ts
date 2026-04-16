import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TraceMatch } from '../../models/trace.model';

@Component({
  selector: 'app-trace-results-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './trace-results-table.component.html',
  styleUrls: ['./trace-results-table.component.scss']
})
export class TraceResultsTableComponent {
  @Input() results: TraceMatch[] = [];
  @Input() selectedTraceId: string | null = null;
  @Input() limitReached = false;
  @Output() resultClick = new EventEmitter<TraceMatch>();

  showFailuresOnly = false;

  filtered(): TraceMatch[] {
    if (!this.showFailuresOnly) return this.results;
    return this.results.filter(r => r.isFailed);
  }

  onRowClick(result: TraceMatch): void {
    this.resultClick.emit(result);
  }

  formatTime(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  formatDuration(nanos: number): string {
    if (!nanos) return '—';
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(2)}s`;
  }

  trackByTraceId = (_: number, r: TraceMatch) => r.traceId;
}
