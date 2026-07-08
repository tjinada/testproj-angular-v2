import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CallerRow } from '../../models/trace.model';

/** View row: a CallerRow plus the list of hosts it covers (one entry
 *  when ungrouped; all merged hosts when grouped by caller name). */
interface CallerDisplayRow extends CallerRow {
  hostList: string[];
}

/**
 * Presentational component: displays the deduped upstream callers of a
 * component — the root/entry apps of traces containing it, sampled
 * across the time window without any URL filter. One caller means a
 * dedicated component; many callers means a common component.
 *
 * "Group by caller name" merges rows that differ only by host/container.
 * Trace counts are summed — provably safe, since each trace has exactly
 * one entry span, so two (name, host) rows can never share a trace.
 */
@Component({
  selector: 'app-caller-results-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './caller-results-table.component.html',
  styleUrls: ['./caller-results-table.component.scss']
})
export class CallerResultsTableComponent implements OnChanges {
  @Input() results: CallerRow[] = [];
  @Input() componentName = '';
  @Input() tracesAnalyzed = 0;
  @Input() tracesRequested = 0;
  @Input() tracesWithRoot = 0;

  /** Emitted when an example trace ID is clicked; the parent runs the
   *  regular trace-by-ID flow (summary, flow diagram, span timeline). */
  @Output() traceClick = new EventEmitter<string>();

  /** When true, rows collapse to one per caller name. */
  groupByName = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['results']) {
      this.groupByName = false;
    }
  }

  onTraceClick(traceId: string): void {
    if (traceId) {
      this.traceClick.emit(traceId);
    }
  }

  displayRows(): CallerDisplayRow[] {
    if (!this.groupByName) {
      return this.results.map(r => ({ ...r, hostList: r.host ? [r.host] : [] }));
    }

    const grouped = new Map<string, CallerDisplayRow>();
    for (const r of this.results) {
      const g = grouped.get(r.name);
      if (!g) {
        grouped.set(r.name, { ...r, hostList: r.host ? [r.host] : [] });
        continue;
      }
      g.traceCount += r.traceCount;
      if (r.host && !g.hostList.includes(r.host)) g.hostList.push(r.host);
      if (r.lastSeen > g.lastSeen) {
        g.lastSeen = r.lastSeen;
        g.exampleTraceId = r.exampleTraceId;
      }
    }
    return Array.from(grouped.values())
      .sort((a, b) => b.traceCount - a.traceCount || a.name.localeCompare(b.name));
  }

  /** Distinct caller names — the honest basis for the common-vs-dedicated
   *  verdict, independent of the grouping toggle. */
  uniqueCallerNames(): number {
    return new Set(this.results.map(r => r.name)).size;
  }

  sharePct(r: CallerRow): string {
    if (!this.tracesWithRoot) return '—';
    return `${Math.round((r.traceCount / this.tracesWithRoot) * 100)}%`;
  }

  formatTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  trackByCaller = (_: number, r: CallerDisplayRow) => `${r.name}||${r.hostList.join('|')}`;
}
