import { ChangeDetectionStrategy, Component, ElementRef, signal, computed, effect, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OpenSearchService, OpenSearchTestResponse } from '../../services/opensearch.service';

interface ParsedLogLine {
  raw: string;
  parsed: boolean;
  timestamp?: string;
  timestampMs?: number;
  level?: string;
  shortClass?: string;
  message?: string;
  prefix?: string;
}

interface LineVM extends ParsedLogLine {
  id: number;
  /** True if the line suggests an error/exception — drives subtle red tint. */
  isErrorLike: boolean;
}

// ── Regexes ─────────────────────────────────────────────────────────

const LINE_REGEX =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}(?:\s+[-+]\d{4})?)\s+\[([^\]]+)\]\s+(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\s+([\w.$]+)\s+(.*?)\s-\s(.*)$/;

// Error signals in the message body (complement to level=ERROR/FATAL).
const ERROR_SIGNAL_REGEX =
  /\b(Exception|Error|Caused by:|FATAL|stacktrace)\b|^\s+at\s+[\w.$]+/i;

// URL / URL-path pattern. Matches any of:
//   1. Full URL with scheme: https://host[:port]/path...
//   2. Host-with-path: api2-sit4.bmogc.net/api/...  (host has at least one dot;
//      followed by at least one path segment)
//   3. Path-only: /api/foo/bar  (leading slash; at least two segments)
//
// The leading-boundary lookbehind uses a non-capturing group so we can anchor
// the path-only case without eating a leading word char. Alternatives 1 and 2
// stand alone; alternative 3 needs the boundary check.
const URL_REGEX = new RegExp(
  [
    // 1. scheme://host[:port]/path
    'https?:\\/\\/[A-Za-z0-9][\\w.-]*(?::\\d+)?(?:\\/[A-Za-z0-9_.~!$&\'()*+,;=:@%-]*)+',
    // 2. host.with.dots[:port]/path
    '(?<![\\w/])[A-Za-z][\\w-]*(?:\\.[A-Za-z][\\w-]*)+(?::\\d+)?(?:\\/[A-Za-z_][\\w.-]*)+',
    // 3. /path/with/at-least-two-segments
    '(?<![\\w/])\\/[A-Za-z_][\\w-]*(?:\\/[A-Za-z_][\\w-]*)+'
  ].join('|'),
  'g'
);

// ── Time range choices ──────────────────────────────────────────────

const TIME_RANGE_CHOICES = [
  { label: 'Last 1 hour',   value: 60 * 60 * 1000 },
  { label: 'Last 4 hours',  value: 4 * 60 * 60 * 1000 },
  { label: 'Last 24 hours', value: 24 * 60 * 60 * 1000 }
] as const;

const DEFAULT_TIME_RANGE_MS = 60 * 60 * 1000;

// ── Parsing ─────────────────────────────────────────────────────────

function parseLine(raw: string): ParsedLogLine {
  const m = LINE_REGEX.exec(raw);
  if (!m) {
    return { raw, parsed: false };
  }
  const [, timestamp, thread, level, fullClass, metadata, message] = m;
  const shortClass = fullClass.includes('.') ? fullClass.split('.').pop()! : fullClass;
  const prefix = `[${thread}] ${fullClass}${metadata ? ' ' + metadata : ''}`;

  let timestampMs: number | undefined;
  const isoish = timestamp.replace(/\s+/, 'T').replace(/\s+([-+]\d{4})$/, '$1');
  const parsedTs = Date.parse(isoish);
  if (!isNaN(parsedTs)) {
    timestampMs = parsedTs;
  }

  return { raw, parsed: true, timestamp, timestampMs, level: level.toUpperCase(), shortClass, message, prefix };
}

function isErrorLikeLine(p: ParsedLogLine): boolean {
  if (p.level === 'ERROR' || p.level === 'FATAL') return true;
  const hay = p.message || p.raw;
  return ERROR_SIGNAL_REGEX.test(hay);
}

/**
 * Extracts log lines from an OpenSearch Dashboards internal-search response.
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

  readonly timeRangeChoices = TIME_RANGE_CHOICES;

  private logLinesContainer = viewChild<ElementRef<HTMLElement>>('logLinesContainer');

  searchTerm = signal<string>('');
  timeRangeMs = signal<number>(DEFAULT_TIME_RANGE_MS);
  isSearching = signal<boolean>(false);
  searchError = signal<string>('');
  response = signal<OpenSearchTestResponse | null>(null);
  hasSearched = signal<boolean>(false);
  lastSearchedTerm = signal<string>('');

  // Elapsed-time tracker
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

  // ── Find-in-results state ─────────────────────────────────────────
  findTerm = signal<string>('');
  currentMatchIndex = signal<number>(-1);

  // ── View model ────────────────────────────────────────────────────

  vmLines = computed<LineVM[]>(() => {
    const r = this.response();
    if (!r) return [];
    const messages = extractMessages(r.raw);
    return messages.map((raw, idx) => {
      const p = parseLine(raw);
      return { id: idx, isErrorLike: isErrorLikeLine(p), ...p };
    });
  });

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

  // ── Find-in-results computed matches ──────────────────────────────

  findMatches = computed<number[]>(() => {
    const term = this.findTerm().trim().toLowerCase();
    if (!term) return [];
    const hits: number[] = [];
    for (const l of this.vmLines()) {
      if (l.raw.toLowerCase().indexOf(term) !== -1) {
        hits.push(l.id);
      }
    }
    return hits;
  });

  findMatchCount = computed(() => this.findMatches().length);
  currentMatchDisplay = computed(() =>
    this.findMatchCount() > 0 ? this.currentMatchIndex() + 1 : 0
  );

  // Expansion state
  private expandedIds = signal<Set<number>>(new Set());

  constructor(private openSearchService: OpenSearchService) {
    // Reset current match when find term changes.
    effect(() => {
      const count = this.findMatchCount();
      this.currentMatchIndex.set(count > 0 ? 0 : -1);
    }, { allowSignalWrites: true });

    // Scroll current find match into view.
    effect(() => {
      const idx = this.currentMatchIndex();
      const matches = this.findMatches();
      if (idx < 0 || idx >= matches.length) return;
      const lineId = matches[idx];
      queueMicrotask(() => this.scrollMatchIntoView(lineId));
    });
  }

  // ── Search ────────────────────────────────────────────────────────

  onSearch(): void {
    const term = this.searchTerm().trim();
    if (!term) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.response.set(null);
    this.hasSearched.set(true);
    this.lastSearchedTerm.set(term);
    this.findTerm.set('');
    this.currentMatchIndex.set(-1);
    this.expandedIds.set(new Set());
    this.startElapsedTimer();

    this.openSearchService.search(term, this.timeRangeMs()).subscribe({
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

  onTimeRangeChange(value: number | string): void {
    const n = typeof value === 'string' ? parseInt(value, 10) : value;
    if (TIME_RANGE_CHOICES.some(c => c.value === n)) {
      this.timeRangeMs.set(n);
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

  // ── Expand / collapse ─────────────────────────────────────────────

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

  // ── Find-in-results navigation ────────────────────────────────────

  onFindKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      if (event.shiftKey) this.prevMatch();
      else this.nextMatch();
    }
  }

  nextMatch(): void {
    const count = this.findMatchCount();
    if (count === 0) return;
    this.currentMatchIndex.set((this.currentMatchIndex() + 1) % count);
  }

  prevMatch(): void {
    const count = this.findMatchCount();
    if (count === 0) return;
    this.currentMatchIndex.set((this.currentMatchIndex() - 1 + count) % count);
  }

  clearFind(): void {
    this.findTerm.set('');
  }

  isCurrentMatch(id: number): boolean {
    const matches = this.findMatches();
    const idx = this.currentMatchIndex();
    return idx >= 0 && idx < matches.length && matches[idx] === id;
  }

  private scrollMatchIntoView(lineId: number): void {
    const container = this.logLinesContainer()?.nativeElement;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-line-id="${lineId}"]`);
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const fullyVisible = elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom;
    if (fullyVisible) return;
    const offset = el.offsetTop - container.offsetTop
      - (container.clientHeight / 2)
      + (el.clientHeight / 2);
    container.scrollTo({ top: offset, behavior: 'smooth' });
  }

  // ── Highlighting ──────────────────────────────────────────────────

  /**
   * Apply all highlights to text: URLs/hosts (cyan), primary search term
   * (yellow), find-in-results (orange, brighter on the current-match line).
   *
   * @param text       The text to highlight
   * @param isCurrent  True if this text is on the line containing the
   *                   CURRENT find match — causes find marks to use a
   *                   brighter variant so Next/Prev is obvious.
   */
  highlight(text: string, isCurrent: boolean = false): string {
    let safe = this.escapeHtml(text);

    // URLs first — cyan
    safe = safe.replace(URL_REGEX, (match) => {
      return `<mark class="log-hl-url">${match}</mark>`;
    });

    // Primary search term — yellow
    const primary = this.lastSearchedTerm();
    if (primary) {
      const re = new RegExp(this.escapeRegex(this.escapeHtml(primary)), 'gi');
      safe = safe.replace(re, '<mark class="log-hl-primary">$&</mark>');
    }

    // Find-in-results — orange, or bright orange on the current-match line
    const find = this.findTerm().trim();
    if (find) {
      const re = new RegExp(this.escapeRegex(this.escapeHtml(find)), 'gi');
      const cls = isCurrent ? 'log-hl-find-current' : 'log-hl-find';
      safe = safe.replace(re, `<mark class="${cls}">$&</mark>`);
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
