import { Component, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OpenSearchService, OpenSearchTestResponse } from '../../services/opensearch.service';

/**
 * TEST component — sends a search term to AWS OpenSearch via the backend
 * and displays the raw JSON response. Used to verify pod-to-OpenSearch
 * connectivity before investing in a full feature.
 */
@Component({
  selector: 'app-opensearch-log-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './opensearch-log-search.component.html',
  styleUrls: ['./opensearch-log-search.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OpenSearchLogSearchComponent {

  searchTerm = signal<string>('');
  isSearching = signal<boolean>(false);
  searchError = signal<string>('');
  response = signal<OpenSearchTestResponse | null>(null);
  hasSearched = signal<boolean>(false);

  // Elapsed timer — reuses the same pattern as CDBBOS Log Search.
  elapsedMs = signal<number>(0);
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private searchStartedAt = 0;

  elapsedDisplay = computed(() => (this.elapsedMs() / 1000).toFixed(1) + 's');

  // Computed pretty JSON for the results panel.
  responseJson = computed(() => {
    const r = this.response();
    if (!r) return '';
    return JSON.stringify(r.raw, null, 2);
  });

  canSearch = computed(() => {
    return this.searchTerm().trim().length > 0 && !this.isSearching();
  });

  constructor(private openSearchService: OpenSearchService) {}

  onSearch(): void {
    const term = this.searchTerm().trim();
    if (!term) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.response.set(null);
    this.hasSearched.set(true);
    this.startElapsedTimer();

    this.openSearchService.search(term).subscribe({
      next: (response) => {
        this.response.set(response);
        this.isSearching.set(false);
        this.stopElapsedTimer();
      },
      error: (err) => {
        this.searchError.set(err?.error?.error || err?.message || 'Failed to call OpenSearch');
        this.isSearching.set(false);
        this.stopElapsedTimer();
      }
    });
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.canSearch()) {
      this.onSearch();
    }
  }

  private startElapsedTimer(): void {
    this.searchStartedAt = Date.now();
    this.elapsedMs.set(0);
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      this.elapsedMs.set(Date.now() - this.searchStartedAt);
    }, 100);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}
