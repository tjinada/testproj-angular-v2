import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EndpointMatch } from '../../models/trace.model';

/**
 * Presentational component: displays unique endpoints (method + URL path
 * pairs) returned by the endpoint search. Used to attest whether an
 * endpoint sees traffic in the selected environment.
 *
 * Features:
 *   - Filter-as-you-type: case-insensitive substring match across
 *     method, URL path, service, and server address. Resets whenever a
 *     new result set arrives so a stale filter doesn't hide rows.
 *   - "Latest trace" action per row: emits the row so the parent can
 *     resolve and load the most recent trace for that endpoint.
 *
 * Ordering is server-side: alphabetical by URL path, method tiebreaker.
 */
@Component({
  selector: 'app-endpoint-results-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './endpoint-results-table.component.html',
  styleUrls: ['./endpoint-results-table.component.scss']
})
export class EndpointResultsTableComponent implements OnChanges {
  @Input() results: EndpointMatch[] = [];
  @Input() limitReached = false;
  @Output() latestTraceClick = new EventEmitter<EndpointMatch>();

  /** Case-insensitive substring filter across the visible text columns. */
  filterText = '';

  ngOnChanges(changes: SimpleChanges): void {
    // Reset the filter when a new result set arrives. Without this, a
    // stale filter from a previous search can silently hide rows.
    if (changes['results']) {
      this.filterText = '';
    }
  }

  filtered(): EndpointMatch[] {
    const needle = this.filterText.trim().toLowerCase();
    if (!needle) return this.results;
    return this.results.filter(r =>
      r.method.toLowerCase().includes(needle) ||
      r.urlPath.toLowerCase().includes(needle) ||
      r.service.toLowerCase().includes(needle) ||
      r.serverAddress.toLowerCase().includes(needle)
    );
  }

  onLatestTraceClick(result: EndpointMatch): void {
    this.latestTraceClick.emit(result);
  }

  formatTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  trackByEndpoint = (_: number, r: EndpointMatch) => `${r.method} ${r.urlPath}`;
}
