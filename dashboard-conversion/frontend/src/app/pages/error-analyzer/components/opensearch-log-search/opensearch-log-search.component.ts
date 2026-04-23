import { ChangeDetectionStrategy, Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OpenSearchService, OpenSearchTestResponse } from '../../services/opensearch.service';

interface ParsedLogLine {
  raw: string;
  parsed: boolean;
  timestamp?: string;
  level?: string;
  shortClass?: string;
  message?: string;
  prefix?: string;
}

interface LineVM extends ParsedLogLine {
  id: number;
}

const LINE_REGEX =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}(?:\s+[-+]\d{4})?)\s+\[([^\]]+)\]\s+(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\s+([\w.$]+)\s+(.*?)\s-\s(.*)$/;

function parseLine(raw: string): ParsedLogLine {
  const m = LINE_REGEX.exec(raw);
  if (!m) {
    return { raw, parsed: false };
  }
  const [, timestamp, thread, level, fullClass, metadata, message] = m;
  const shortClass = fullClass.includes('.') ? fullClass.split('.').pop()! : fullClass;
  const prefix = `[${thread}] ${fullClass}${metadata ? ' ' + metadata : ''}`;
  return { raw, parsed: true, timestamp, level: level.toUpperCase(), shortClass, message, prefix };
}

/**
 * Extracts log lines from an OpenSearch Dashboards internal-search response.
 * The shape is:
 *   { rawResponse: { hits: { hits: [{ _source: { message: string, ... } }] } } }
 * Falls back to `raw.hits.hits` for direct OpenSearch responses.
 */
function extractMessages(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const r: any = raw;
  const hits = r?.rawResponse?.hits?.hits ?? r?.hits?.hits ?? [];
  if (!Array.isArray(hits)) return [];
  const out: string[] = [];
  for (const hit of hits) {
    const msg = hit?._source?.message;
    if (typeof msg === 'string' && msg.length > 0) {
      out.push(msg);
    }
  }
  return out;
}

/**
 * TEST component — sends a search term to AWS OpenSearch via the backend
 * and renders the `_source.message` field from each hit using the same
 * log-line formatting as CDBBOS Log Search.
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
  lastSearchedTerm = signal<string>('');

  // Elapsed-time tracker for the in-progress indicator.
  elapsedMs = signal<number>(0);
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private searchStartedAt = 0;

  elapsedDisplay = computed(() => (this.elapsedMs() / 1000).toFixed(1) + 's');
  searchHint = computed(() => {
    const ms = this.elapsedMs();
    if (ms < 10_000) return '';
    if (ms < 30_000) return 'Querying OpenSearch…';
    return 'Still waiting on OpenSearch — large result set or slow response…';
  });

  // Parsed log lines, derived from the response hits.
  vmLines = computed<LineVM[]>(() => {
    const r = this.response();
    if (!r) return [];
    const messages = extractMessages(r.raw);
    return messages.map((raw, idx) => ({ id: idx, ...parseLine(raw) }));
  });

  // Total hits reported by OpenSearch (may exceed returned hit count).
  totalHits = computed<number>(() => {
    const r = this.response();
    if (!r) return 0;
    const raw: any = r.raw;
    const total = raw?.rawResponse?.hits?.total ?? raw?.hits?.total;
    if (typeof total === 'number') return total;
    if (typeof total === 'object' && typeof total?.value === 'number') return total.value;
    return 0;
  });

  returnedCount = computed<number>(() => this.vmLines().length);

  canSearch = computed<boolean>(() =>
    this.searchTerm().trim().length > 0 && !this.isSearching()
  );

  // Expansion state — toggled by click on a line.
  private expandedIds = signal<Set<number>>(new Set());

  constructor(private openSearchService: OpenSearchService) {}

  onSearch(): void {
    const term = this.searchTerm().trim();
    if (!term) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.response.set(null);
    this.hasSearched.set(true);
    this.lastSearchedTerm.set(term);
    this.expandedIds.set(new Set());
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

  // ── Expand / collapse handlers ────────────────────────────────────

  isExpanded(id: number): boolean {
    return this.expandedIds().has(id);
  }

  onLineMouseup(id: number, line: LineVM): void {
    if (!line.parsed) return;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (sel && sel.toString().length > 0) return;
    this.toggleLine(id);
  }

  toggleLine(id: number): void {
    this.expandedIds.update(set => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  expandAll(): void {
    const all = new Set<number>();
    for (const l of this.vmLines()) {
      if (l.parsed) all.add(l.id);
    }
    this.expandedIds.set(all);
  }

  collapseAll(): void {
    this.expandedIds.set(new Set());
  }

  trackById(_index: number, line: LineVM): number {
    return line.id;
  }

  // ── Highlighting ──────────────────────────────────────────────────

  highlight(text: string): string {
    let safe = this.escapeHtml(text);
    const primary = this.lastSearchedTerm();
    if (primary) {
      const re = new RegExp(this.escapeRegex(this.escapeHtml(primary)), 'gi');
      safe = safe.replace(re, '<mark class="log-hl-primary">$&</mark>');
    }
    return safe;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  levelClass(level: string | undefined): string {
    if (!level) return '';
    switch (level) {
      case 'ERROR':
      case 'FATAL':
        return 'lvl-error';
      case 'WARN':
      case 'WARNING':
        return 'lvl-warn';
      case 'INFO':
        return 'lvl-info';
      case 'DEBUG':
      case 'TRACE':
        return 'lvl-debug';
      default:
        return '';
    }
  }
}
