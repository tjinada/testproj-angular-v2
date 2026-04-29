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

/** Recent presets — search [now - durationMs, now]. */
const RECENT_RANGE_PRESETS = [
  { id: '15m', label: 'Last 15 minutes', durationMs: 15 * 60 * 1000 },
  { id: '30m', label: 'Last 30 minutes', durationMs: 30 * 60 * 1000 },
  { id: '1h',  label: 'Last 1 hour',     durationMs: 60 * 60 * 1000 }
] as const;

/** Window-size choices when in "Around a time" mode. */
const AROUND_WINDOW_CHOICES = [
  { id: '15m', label: '15 min', durationMs: 15 * 60 * 1000 },
  { id: '30m', label: '30 min', durationMs: 30 * 60 * 1000 },
  { id: '60m', label: '1 hour', durationMs: 60 * 60 * 1000 }
] as const;

const AROUND_MODE_ID = 'around';
const DEFAULT_RANGE_ID = '15m';
const DEFAULT_AROUND_WINDOW_ID = '15m';

// ── Parsing ─────────────────────────────────────────────────────────

function parseLine(raw: string): ParsedLogLine {
  // JSON-shaped log line (e.g. project.* index emits each message as a JSON
  // object with named fields). Try this first; fall back to the regex path
  // for plain-text lines (e.g. CDBBOS / channels-olb-*).
  if (raw.length > 0 && raw.charCodeAt(0) === 0x7B /* '{' */) {
    const json = parseJsonLogLine(raw);
    if (json) return json;
  }

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

/**
 * Attempt to parse a JSON-shaped log line. Returns null if the string isn't
 * valid JSON, isn't an object, or doesn't have the minimum expected shape
 * (timestamp + logLevel). Maps named fields onto the same ParsedLogLine
 * structure used by the regex path so the rest of the component stays
 * agnostic to log format.
 */
function parseJsonLogLine(raw: string): ParsedLogLine | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // Field-name variations seen across indices:
  //   timestamp — some emit `timestamp`, others `@timestamp`
  //   message — some emit `message` (full payload), others `additionalInfo` (summary)
  const timestampRaw = (typeof obj.timestamp === 'string' && obj.timestamp)
    || (typeof obj['@timestamp'] === 'string' && obj['@timestamp'])
    || undefined;
  const level = typeof obj.logLevel === 'string' ? obj.logLevel.toUpperCase() : undefined;
  if (!timestampRaw || !level) return null;

  const logger = typeof obj.logger === 'string' ? obj.logger : '';
  const message = (typeof obj.message === 'string' && obj.message)
    || (typeof obj.additionalInfo === 'string' && obj.additionalInfo)
    || '';
  const thread = typeof obj.thread === 'string' ? obj.thread : '';
  const shortClass = logger.includes('.') ? logger.split('.').pop()! : logger;
  const prefix = thread ? `[${thread}] ${logger}` : logger;

  let timestampMs: number | undefined;
  // Normalize the various forms we've seen:
  //   "2026-04-29 13:50:49.089 UTC"     → "2026-04-29T13:50:49.089Z"
  //   "2026-04-27T15:32:18.258+0000"    → already ISO-ish, Date.parse handles it
  //   "2026-04-27T15:32:18.249Z"        → already ISO
  const isoish = timestampRaw
    .replace(/\s+UTC$/i, 'Z')
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  const parsedTs = Date.parse(isoish);
  if (!isNaN(parsedTs)) {
    timestampMs = parsedTs;
  }

  return { raw, parsed: true, timestamp: timestampRaw, timestampMs, level, shortClass, message, prefix };
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

  readonly recentRangePresets = RECENT_RANGE_PRESETS;
  readonly aroundWindowChoices = AROUND_WINDOW_CHOICES;
  readonly aroundModeId = AROUND_MODE_ID;

  private configService = inject(ConfigService);
  private logLinesContainer = viewChild<ElementRef<HTMLElement>>('logLinesContainer');

  // Index dropdown — sourced from ConfigService
  indexOptions = signal<OpenSearchIndexOption[]>([]);
  selectedIndex = signal<string>('');

  searchTerm = signal<string>('');

  // Range state. `selectedRangeId` is either a preset id (e.g. '15m') or
  // the special AROUND_MODE_ID. When in 'around' mode, `aroundStart` and
  // `aroundWindowId` drive the [from, to] computation.
  selectedRangeId = signal<string>(DEFAULT_RANGE_ID);
  aroundStart = signal<string>(''); // datetime-local value, e.g. "2026-04-29T10:30"
  aroundWindowId = signal<string>(DEFAULT_AROUND_WINDOW_ID);
  rangeError = signal<string>('');

  isAroundMode = computed<boolean>(() => this.selectedRangeId() === AROUND_MODE_ID);
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
    // Reactively track config so dropdown updates when /config finishes loading.
    // (Parent's async ngOnInit may not have resolved by the time this child's
    // ngOnInit runs, so a one-shot read would lock in DEFAULT_INDICES.)
    effect(() => {
      const options = this.configService.config().openSearchIndices;
      this.indexOptions.set(options);
      if (options.length > 0 && !this.selectedIndex()) {
        this.selectedIndex.set(options[0].value);
      }
    }, { allowSignalWrites: true });

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

    const range = this.buildRange();
    if (!range) return;

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

    this.openSearchService.search(term, range.from, range.to, idx).subscribe({
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

  /**
   * Compute the [from, to] ISO range from the current UI state. Sets
   * `rangeError` and returns null if the user is in "around" mode but
   * hasn't supplied a valid start time.
   */
  private buildRange(): { from: string; to: string } | null {
    this.rangeError.set('');

    if (!this.isAroundMode()) {
      const preset = this.recentRangePresets.find(p => p.id === this.selectedRangeId())
        ?? this.recentRangePresets[0];
      const now = Date.now();
      return {
        from: new Date(now - preset.durationMs).toISOString(),
        to: new Date(now).toISOString()
      };
    }

    // Around-a-time mode.
    const start = this.aroundStart();
    if (!start) {
      this.rangeError.set('Pick a start time.');
      return null;
    }
    const startMs = new Date(start).getTime();
    if (isNaN(startMs)) {
      this.rangeError.set('Invalid start time.');
      return null;
    }
    const window = this.aroundWindowChoices.find(w => w.id === this.aroundWindowId())
      ?? this.aroundWindowChoices[0];
    let endMs = startMs + window.durationMs;
    const now = Date.now();
    if (startMs > now) {
      this.rangeError.set('Start time cannot be in the future.');
      return null;
    }
    // Cap `to` at now — don't query the future.
    if (endMs > now) endMs = now;

    return {
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString()
    };
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.canSearch()) {
      this.onSearch();
    }
  }

  onRangeChange(value: string): void {
    this.rangeError.set('');
    if (value === AROUND_MODE_ID) {
      this.selectedRangeId.set(AROUND_MODE_ID);
      // If no start time has been entered yet, pre-fill with "now minus 15min"
      // so the picker has a sensible default the user can adjust.
      if (!this.aroundStart()) {
        this.aroundStart.set(this.toLocalInputValue(new Date(Date.now() - 15 * 60 * 1000)));
      }
      return;
    }
    if (this.recentRangePresets.some(p => p.id === value)) {
      this.selectedRangeId.set(value);
    }
  }

  onAroundStartChange(value: string): void {
    this.aroundStart.set(value);
    this.rangeError.set('');
  }

  onAroundWindowChange(value: string): void {
    if (this.aroundWindowChoices.some(w => w.id === value)) {
      this.aroundWindowId.set(value);
    }
  }

  /** Format a Date as the value expected by `<input type="datetime-local">`. */
  private toLocalInputValue(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
