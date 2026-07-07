import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CallerRow } from '../../models/trace.model';

/**
 * Presentational component: displays the deduped upstream callers of a
 * component — the root/entry apps of traces containing it, sampled
 * across the time window without any URL filter. One caller means a
 * dedicated component; many callers means a common component.
 */
@Component({
  selector: 'app-caller-results-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './caller-results-table.component.html',
  styleUrls: ['./caller-results-table.component.scss']
})
export class CallerResultsTableComponent {
  @Input() results: CallerRow[] = [];
  @Input() componentName = '';
  @Input() tracesAnalyzed = 0;
  @Input() tracesRequested = 0;
  @Input() tracesWithRoot = 0;

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

  trackByCaller = (_: number, r: CallerRow) => `${r.name}||${r.host}`;
}
