import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ComponentRow } from '../../models/trace.model';

/**
 * Presentational component: displays the deduped list of components
 * touched by an exact url.path across the sampled 200-status traces.
 * "Component" means a flow-diagram box — real services plus synthetic
 * external/DB nodes — so rows are derived by the parent via the same
 * buildFlowGraph() the flow diagram uses.
 *
 * Filter-as-you-type mirrors the endpoint results table: case-insensitive
 * substring match across name, type, and hostname. Resets whenever a new
 * result set arrives so a stale filter doesn't hide rows.
 */
@Component({
  selector: 'app-component-results-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './component-results-table.component.html',
  styleUrls: ['./component-results-table.component.scss']
})
export class ComponentResultsTableComponent implements OnChanges {
  @Input() results: ComponentRow[] = [];
  @Input() tracesAnalyzed = 0;
  @Input() tracesRequested = 0;

  /** Emitted when "Find callers" is clicked on a real (non-synthetic)
   *  component row; the parent runs the URL-independent caller search. */
  @Output() findCallersClick = new EventEmitter<ComponentRow>();

  /** Case-insensitive substring filter across the visible text columns. */
  filterText = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['results']) {
      this.filterText = '';
    }
  }

  filtered(): ComponentRow[] {
    const needle = this.filterText.trim().toLowerCase();
    if (!needle) return this.results;
    return this.results.filter(r =>
      r.name.toLowerCase().includes(needle) ||
      r.type.toLowerCase().includes(needle) ||
      r.fullHostname.toLowerCase().includes(needle)
    );
  }

  onFindCallersClick(row: ComponentRow): void {
    this.findCallersClick.emit(row);
  }

  trackByComponent = (_: number, r: ComponentRow) => r.id;
}
