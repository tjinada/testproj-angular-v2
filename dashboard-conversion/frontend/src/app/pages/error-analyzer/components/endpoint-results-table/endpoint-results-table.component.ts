import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EndpointMatch } from '../../models/trace.model';

/**
 * Presentational component: displays unique endpoints (method + URL path
 * pairs) returned by the endpoint search. Used to attest whether an
 * endpoint sees traffic in the selected environment.
 *
 * Read-only — rows are not clickable. Ordering is server-side:
 * alphabetical by URL path, method as tiebreaker.
 */
@Component({
  selector: 'app-endpoint-results-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './endpoint-results-table.component.html',
  styleUrls: ['./endpoint-results-table.component.scss']
})
export class EndpointResultsTableComponent {
  @Input() results: EndpointMatch[] = [];
  @Input() limitReached = false;

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
