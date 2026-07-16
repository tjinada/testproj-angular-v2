import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TraceMatch } from '../../models/trace.model';

/**
 * Presentational component: displays a list of trace matches in a table
 * with client-side filters and click-to-select behavior.
 *
 * Filters available:
 *   - "Show failures & exceptions": rows where isFailed OR hasExceptions
 *   - Environment (host) dropdown: exact-match on serverAddress, populated
 *     with the unique hosts present in the current result set.
 *
 * Filters compose (AND). The environment filter resets whenever a new
 * result set arrives so a stale selection doesn't silently hide rows.
 */
@Component({
  selector: 'app-trace-results-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './trace-results-table.component.html',
  styleUrls: ['./trace-results-table.component.scss']
})
export class TraceResultsTableComponent implements OnChanges {
  @Input() results: TraceMatch[] = [];
  @Input() selectedTraceId: string | null = null;
  /** True when the last page was full — older traces may exist in the window. */
  @Input() canLoadMore = false;
  /** True while a load-more request is in flight; disables the button. */
  @Input() isLoadingMore = false;
  @Output() resultClick = new EventEmitter<TraceMatch>();
  @Output() loadMore = new EventEmitter<void>();

  /** Toggle: show only rows that failed outright OR captured an exception. */
  showFailuresOnly = false;

  /** Exact-match environment filter. Empty string = no filter (all hosts). */
  selectedHost = '';

  ngOnChanges(changes: SimpleChanges): void {
    // Reset the environment filter when the result set changes and the
    // selected host is no longer present. Without this, a stale selection
    // from a previous search can silently produce an empty table. Keeping
    // the selection when the host still exists means load-more appends
    // don't wipe the user's filter.
    if (changes['results'] && this.selectedHost && !this.uniqueHosts.includes(this.selectedHost)) {
      this.selectedHost = '';
    }
  }

  onLoadMoreClick(): void {
    if (this.isLoadingMore) return;
    this.loadMore.emit();
  }

  /**
   * Distinct, non-empty server addresses from the current results, sorted
   * alphabetically. Used to populate the environment dropdown.
   */
  get uniqueHosts(): string[] {
    const set = new Set<string>();
    for (const r of this.results) {
      if (r.serverAddress) set.add(r.serverAddress);
    }
    return Array.from(set).sort();
  }

  /**
   * Returns results with all active filters applied. Composes:
   *   - failures & exceptions toggle (isFailed OR hasExceptions)
   *   - environment exact-match
   */
  filtered(): TraceMatch[] {
    let out = this.results;
    if (this.showFailuresOnly) {
      out = out.filter(r => r.isFailed || r.hasExceptions);
    }
    if (this.selectedHost) {
      out = out.filter(r => r.serverAddress === this.selectedHost);
    }
    return out;
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
