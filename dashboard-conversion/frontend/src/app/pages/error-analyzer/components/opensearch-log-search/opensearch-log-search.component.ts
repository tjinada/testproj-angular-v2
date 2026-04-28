import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, signal, computed, effect, inject, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OpenSearchService, OpenSearchTestResponse } from '../../services/opensearch.service';
import { ConfigService, OpenSearchIndexOption } from '../../services/config.service';

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

// URL / URL-path pattern.
const URL_REGEX = new RegExp(
  [
    'https?:\\/\\/[A-Za-z0-9][\\w.-]*(?::\\d+)?(?:\\/[A-Za-z0-9_.~!$&\'()*+,;=:@%-]*)+',
    '(?<![\\w/])[A-Za-z][\\w-]*(?:\\.[A-Za-z][\\w-]*)+(?::\\d+)?(?:\\/[A-Za-z_][\\w.-]*)+',
    '(?<![\\w/])\\/[A-Za-z_][\\w-]*(?:\\/[A-Za-z_][\\w-]*)+'
  ].join('|'),
  'g'
);

// ── Time range choices ──────────────────────────────────────────────

const TIME_RANGE_CHOICES = [
  { label: 'Last 15 minutes', value: 15 * 60 * 1000 },
  { label: 'Last 30 minutes', value: 30 * 60 * 1000 },
  { label: 'Last 1 hour',     value: 60 * 60 * 1000 },
  { label: 'Last 2 hours',    value: 2 * 60 * 60 * 1000 },
  { label: 'Last 6 hours',    value: 6 * 60 * 60 * 1000 },
  { label: 'Last 24 hours',   value: 24 * 60 * 60 * 1000 }
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

@Component({
  selector: 'app-opensearch-log-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './opensearch-log-search.component.html',
  styleUrls: ['./opensearch-log-search.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OpenSearchLogSearchComponent implements OnInit, OnDestroy {

  readonly timeRangeChoices = TIME_RANGE_CHOICES;

  private configService = inject(ConfigService);
  private logLinesContainer = viewChild<ElementRef<HTMLElement>>('logLinesContainer');

  // Index dropdown — sourced from ConfigService
  indexOptions = signal<OpenSearchIndexOption[]>([]);
  selectedIndex = signal<string>('');

  searchTerm = signal<string>('');
  timeRangeMs = signal<number>(DEFAULT_TIME_RANGE_MS);
  isSearching = signal<boolean>(false);
  searchError = signal<string>('');
  response = signal<OpenSearchTestResponse | null>(null);
  hasSearched = signal<boolean>(false);
  lastSearchedTerm = signal<string>('');

  /** Help section open by default; auto-collapses on first search. User can re-open manually. */
  showHelp = signal<boolean>(true);

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

  // ── Mark state ────────────────────────────────────────────────────
  /** Set of line IDs the user has marked. Resets on every new search. */
  private markedIds = signal<Set<number>>(new Set());
  currentMarkIndex = signal<number>(-1);

  /**
   * True when the user has a non-empty text selection *inside* the log-lines
   * container. Drives the enabled state of the "Mark selection" button.
   * Updated by a document-level `selectionchange` listener.
   */
  hasSelection = signal<boolean>(false);
  private selectionChangeHandler: (() => void) | null = null;

  /** Transient "Copied ✓" confirmation message. */
  copyFeedback = signal<string>('');
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.searchTerm().trim().length > 0 &&
    !this.isSearching() &&
    !!this.selectedIndex()
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

  // ── Mark computed ─────────────────────────────────────────────────

  /** Sorted array of marked line IDs — sorted ascending so navigation follows visual order. */
  markedList = computed<number[]>(() => {
    return Array.from(this.markedIds()).sort((a, b) => a - b);
  });

  markedCount = computed<number>(() => this.markedList().length);
  currentMarkDisplay = computed<number>(() =>
    this.markedCount() > 0 ? this.currentMarkIndex() + 1 : 0
  );

  // Expansion state
  private expandedIds = signal<Set<number>>(new Set());

  constructor(private openSearchService: OpenSearchService) {
    effect(() => {
      const count = this.findMatchCount();
      this.currentMatchIndex.set(count > 0 ? 0 : -1);
    }, { allowSignalWrites: true });

    effect(() => {
      const idx = this.currentMatchIndex();
      const matches = this.findMatches();
      if (idx < 0 || idx >= matches.length) return;
      const lineId = matches[idx];
      queueMicrotask(() => this.scrollLineIntoView(lineId));
    });

    // Scroll current-mark into view.
    effect(() => {
      const idx = this.currentMarkIndex();
      const list = this.markedList();
      if (idx < 0 || idx >= list.length) return;
      const lineId = list[idx];
      queueMicrotask(() => this.scrollLineIntoView(lineId));
    });
  }

  ngOnInit(): void {
    const options = this.configService.getOpenSearchIndices();
    this.indexOptions.set(options);
    if (options.length > 0 && !this.selectedIndex()) {
      this.selectedIndex.set(options[0].value);
    }

    // Track text selection inside the log-lines container.
    // `selectionchange` fires on document; we filter to selections whose range
    // anchor is inside our container.
    this.selectionChangeHandler = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        this.hasSelection.set(false);
        return;
      }
      const container = this.logLinesContainer()?.nativeElement;
      if (!container) {
        this.hasSelection.set(false);
        return;
      }
      const range = sel.getRangeAt(0);
      const inside = container.contains(range.commonAncestorContainer);
      this.hasSelection.set(inside && sel.toString().length > 0);
    };
    document.addEventListener('selectionchange', this.selectionChangeHandler);
  }

  ngOnDestroy(): void {
    if (this.selectionChangeHandler) {
      document.removeEventListener('selectionchange', this.selectionChangeHandler);
      this.selectionChangeHandler = null;
    }
    if (this.elapsedTimer !== null) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    if (this.copyFeedbackTimer !== null) {
      clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = null;
    }
  }

  // ── Search ────────────────────────────────────────────────────────

  onSearch(): void {
    const term = this.searchTerm().trim();
    const idx = this.selectedIndex();
    if (!term || !idx) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.response.set(null);
    this.hasSearched.set(true);
    this.lastSearchedTerm.set(term);
    this.showHelp.set(false);
    this.findTerm.set('');
    this.currentMatchIndex.set(-1);
    this.expandedIds.set(new Set());
    // Reset marks on every new search — marks tied to previous result set.
    this.markedIds.set(new Set());
    this.currentMarkIndex.set(-1);
    this.startElapsedTimer();

    this.openSearchService.search(term, this.timeRangeMs(), idx).subscribe({
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

  onIndexChange(value: string): void {
    if (this.indexOptions().some(o => o.value === value)) {
      this.selectedIndex.set(value);
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

  // ── Mark handlers ─────────────────────────────────────────────────

  isMarked(id: number): boolean {
    return this.markedIds().has(id);
  }

  /**
   * Mark all lines touched by the current text selection. Called from the
   * "Mark selection" button. If the selection spans multiple lines, all of
   * them get marked. The browser selection is cleared after.
   *
   * If no selection is active, this is a no-op.
   */
  markSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const container = this.logLinesContainer()?.nativeElement;
    if (!container) return;

    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    // Walk up from both endpoints to find their `.log-line` ancestor and its
    // data-line-id. Then mark every line whose id falls in that inclusive range.
    const startId = this.lineIdForNode(range.startContainer, container);
    const endId = this.lineIdForNode(range.endContainer, container);
    if (startId === null && endId === null) return;

    const lo = Math.min(startId ?? endId!, endId ?? startId!);
    const hi = Math.max(startId ?? endId!, endId ?? startId!);

    this.markedIds.update(set => {
      const next = new Set(set);
      for (let i = lo; i <= hi; i++) next.add(i);
      return next;
    });

    // Activate the first newly-marked line so Next/Prev starts somewhere sensible.
    if (this.currentMarkIndex() === -1) {
      this.currentMarkIndex.set(0);
    }

    // Clear the browser selection so the yellow selection color goes away
    // and the gold mark highlight is unobstructed.
    sel.removeAllRanges();
    this.hasSelection.set(false);
  }

  /**
   * Unmark a single line. Called from a small "×" button that appears on
   * marked lines, so users can remove individual marks without clearing all.
   */
  unmarkLine(id: number, event: Event): void {
    event.stopPropagation();
    this.markedIds.update(set => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
    const newCount = this.markedList().length;
    if (this.currentMarkIndex() >= newCount) {
      this.currentMarkIndex.set(newCount > 0 ? newCount - 1 : -1);
    }
  }

  /**
   * Walk up from an arbitrary DOM node to the nearest ancestor with
   * `data-line-id`, and return the numeric line ID. Returns null if the
   * node is not inside a log line (e.g., clicked in a gap).
   */
  private lineIdForNode(node: Node, container: HTMLElement): number | null {
    let el: Node | null = node;
    while (el && el !== container) {
      if (el.nodeType === Node.ELEMENT_NODE) {
        const idAttr = (el as HTMLElement).getAttribute?.('data-line-id');
        if (idAttr !== null && idAttr !== undefined) {
          const n = parseInt(idAttr, 10);
          if (!isNaN(n)) return n;
        }
      }
      el = el.parentNode;
    }
    return null;
  }

  /** Keyboard shortcut: Ctrl+M / Cmd+M on the log-lines container marks the selection. */
  onLinesKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && (event.key === 'm' || event.key === 'M')) {
      if (this.hasSelection()) {
        event.preventDefault();
        this.markSelection();
      }
    }
  }

  nextMark(): void {
    const count = this.markedCount();
    if (count === 0) return;
    this.currentMarkIndex.set((this.currentMarkIndex() + 1) % count);
  }

  prevMark(): void {
    const count = this.markedCount();
    if (count === 0) return;
    this.currentMarkIndex.set((this.currentMarkIndex() - 1 + count) % count);
  }

  clearMarks(): void {
    this.markedIds.set(new Set());
    this.currentMarkIndex.set(-1);
  }

  isCurrentMark(id: number): boolean {
    const list = this.markedList();
    const idx = this.currentMarkIndex();
    return idx >= 0 && idx < list.length && list[idx] === id;
  }

  // ── Copy handlers ─────────────────────────────────────────────────

  copyMarked(): void {
    const marked = this.markedList();
    if (marked.length === 0) return;
    const lines = this.vmLines();
    const byId = new Map(lines.map(l => [l.id, l.raw]));
    const text = marked.map(id => byId.get(id) || '').filter(Boolean).join('\n');
    this.writeToClipboard(text, `Copied ${marked.length} marked line${marked.length === 1 ? '' : 's'}`);
  }

  copyAll(): void {
    const lines = this.vmLines();
    if (lines.length === 0) return;
    const text = lines.map(l => l.raw).join('\n');
    this.writeToClipboard(text, `Copied ${lines.length} line${lines.length === 1 ? '' : 's'}`);
  }

  private writeToClipboard(text: string, successMessage: string): void {
    // navigator.clipboard requires a secure context (https or localhost).
    // Fall back to a hidden textarea + execCommand('copy') otherwise.
    const done = () => this.showCopyFeedback(successMessage);
    const fail = (err: any) => {
      console.error('[OpenSearch] Copy failed:', err);
      this.showCopyFeedback('Copy failed');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
      return;
    }

    // Fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) done();
      else fail(new Error('execCommand returned false'));
    } catch (err) {
      fail(err);
    }
  }

  private showCopyFeedback(msg: string): void {
    this.copyFeedback.set(msg);
    if (this.copyFeedbackTimer !== null) {
      clearTimeout(this.copyFeedbackTimer);
    }
    this.copyFeedbackTimer = setTimeout(() => {
      this.copyFeedback.set('');
      this.copyFeedbackTimer = null;
    }, 2500);
  }

  // ── Scroll helpers ────────────────────────────────────────────────

  private scrollLineIntoView(lineId: number): void {
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

  highlight(text: string, isCurrent: boolean = false): string {
    let safe = this.escapeHtml(text);

    safe = safe.replace(URL_REGEX, (match) => {
      return `<mark class="log-hl-url">${match}</mark>`;
    });

    const primary = this.lastSearchedTerm();
    if (primary) {
      const re = new RegExp(this.escapeRegex(this.escapeHtml(primary)), 'gi');
      safe = safe.replace(re, '<mark class="log-hl-primary">$&</mark>');
    }

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
