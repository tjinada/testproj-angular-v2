import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TraceMatch } from '../../models/trace.model';

/**
 * Presentational component: displays a list of trace matches in a table
 * with a "Show failures only" toggle and click-to-select behavior.
 *
 * Used by URL search today; intended for reuse by hotspot search, service
 * search, and slow-request detection as those get added.
 */
@Component({
  selector: 'app-trace-results-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './trace-results-table.component.html',
  styleUrls: ['./trace-results-table.component.css']
})
export class TraceResultsTableComponent {
  /** The full list of trace matches to display. */
  @Input() results: TraceMatch[] = [];

  /** Trace ID of the currently selected row (for highlighting). */
  @Input() selectedTraceId: string | null = null;

  /** Whether the backend hit the result cap (shows a small note in the header). */
  @Input() limitReached = false;

  /** Emitted when a row is clicked. Parent handles loading the trace. */
  @Output() resultClick = new EventEmitter<TraceMatch>();

  /** Local toggle state — purely a display concern, stays inside the component. */
  showFailuresOnly = false;

  /**
   * Returns the results filtered by the "failures only" toggle. Client-side
   * only so toggling is instant with no backend round-trip.
   */
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
