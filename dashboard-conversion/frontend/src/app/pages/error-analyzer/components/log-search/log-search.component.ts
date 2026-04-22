import { ChangeDetectionStrategy, Component, ElementRef, OnInit, signal, computed, inject, effect, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LogService } from '../../services/log.service';
import { EnvOption, LogEntry, isGap } from '../../models/log.model';

interface ParsedLogLine {
  raw: string;
  parsed: boolean;
  timestamp?: string;
  level?: string;
  shortClass?: string;
  message?: string;
  prefix?: string;
}

/** VM entry — either a rendered log line or a gap marker. */
type LineVM =
  | (ParsedLogLine & {
      kind: 'line';
      id: number;       // unique per render; stable across filter changes
      lineNum: number;  // original line number in the log file
      isMatch: boolean;
      expanded: boolean;
    })
  | {
      kind: 'gap';
      id: number;
      skipped: number;
    };

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

const CONTEXT_CHOICES = [5, 20, 50, 100] as const;
type ContextSize = typeof CONTEXT_CHOICES[number];

@Component({
  selector: 'app-log-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './log-search.component.html',
  styleUrls: ['./log-search.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogSearchComponent implements OnInit {

  private logService = inject(LogService);
  private logLinesContainer = viewChild<ElementRef<HTMLElement>>('logLinesContainer');

  // Exposed to template
  readonly contextChoices = CONTEXT_CHOICES;

  // ── Env dropdown state ────────────────────────────────────────────
  envs = signal<EnvOption[]>([]);
  selectedEnvName = signal<string>('');
  isLoadingEnvs = signal<boolean>(false);
  envsError = signal<string>('');

  // ── Primary search state ──────────────────────────────────────────
  searchTerm = signal<string>('');
  isSearching = signal<boolean>(false);
  searchError = signal<string>('');
  rawEntries = signal<LogEntry[]>([]);
  totalMatched = signal<number>(0);
  matchesReturned = signal<number>(0);
  truncated = signal<boolean>(false);
  serverContextSize = signal<number>(0);
  hasSearched = signal<boolean>(false);
  lastSearchedTerm = signal<string>('');

  // ── Context controls ──────────────────────────────────────────────
  showContext = signal<boolean>(false);
  contextSize = signal<ContextSize>(20);

  // ── Find-in-results state ─────────────────────────────────────────
  findTerm = signal<string>('');
  currentMatchIndex = signal<number>(-1);

  // ── Derived view-model ────────────────────────────────────────────

  /**
   * Rebuild the VM whenever: raw entries change, the context toggle flips,
   * or the context size changes. When context is off, we show only matches
   * (no context lines, no gaps). When on, we slice each context window to
   * the requested size (server always captures the max).
   */
  vmLines = computed<LineVM[]>(() => {
    const entries = this.rawEntries();
    if (entries.length === 0) return [];

    const show = this.showContext();
    const size = this.contextSize();

    if (!show) {
      // Filter down to matches only; no gaps.
      const out: LineVM[] = [];
      let id = 0;
      for (const e of entries) {
        if (isGap(e)) continue;
        if (!e.isMatch) continue;
        out.push({
          kind: 'line',
          id: id++,
          lineNum: e.lineNum,
          isMatch: true,
          expanded: false,
          ...parseLine(e.text)
        });
      }
      return out;
    }

    // Context mode: slice each match's surrounding window down to `size`
    // by walking the entries, tracking distance from the nearest match.
    // Server always captured 100 before/after; we filter to the requested size.
    const lineEntries = entries.filter((e): e is Exclude<LogEntry, { gap: true }> => !isGap(e));

    // First pass: compute, for each line, the distance (in line numbers
    // within the emitted-set) to the nearest match. Since the server only
    // emits match + surrounding context, a line is within N of a match
    // if `|lineNum - nearestMatchLineNum| <= N`.
    // Because matches themselves are in the array, we can scan through.
    const matchLineNums: number[] = [];
    for (const e of lineEntries) {
      if (e.isMatch) matchLineNums.push(e.lineNum);
    }

    // For each line, find nearest match distance via two-pointer sweep.
    const nearestDistance = new Map<number, number>();
    let pointer = 0;
    for (const e of lineEntries) {
      // Advance pointer while next match is closer.
      while (
        pointer < matchLineNums.length - 1 &&
        Math.abs(matchLineNums[pointer + 1] - e.lineNum) <= Math.abs(matchLineNums[pointer] - e.lineNum)
      ) {
        pointer += 1;
      }
      const nearestForward = matchLineNums[pointer];
      // Also check backward pointer for correctness when lines are before first match.
      let best = Math.abs(nearestForward - e.lineNum);
      if (pointer > 0) {
        const d = Math.abs(matchLineNums[pointer - 1] - e.lineNum);
        if (d < best) best = d;
      }
      nearestDistance.set(e.lineNum, best);
    }

    // Second pass: include only lines within `size` of a match, inserting
    // gap markers when non-adjacent.
    const kept: Exclude<LogEntry, { gap: true }>[] = [];
    for (const e of lineEntries) {
      const d = nearestDistance.get(e.lineNum) ?? Infinity;
      if (e.isMatch || d <= size) {
        kept.push(e);
      }
    }

    const out: LineVM[] = [];
    let id = 0;
    for (let i = 0; i < kept.length; i++) {
      if (i > 0) {
        const gapSize = kept[i].lineNum - kept[i - 1].lineNum - 1;
        if (gapSize > 0) {
          out.push({ kind: 'gap', id: id++, skipped: gapSize });
        }
      }
      const e = kept[i];
      out.push({
        kind: 'line',
        id: id++,
        lineNum: e.lineNum,
        isMatch: e.isMatch,
        expanded: false,
        ...parseLine(e.text)
      });
    }
    return out;
  });

  // Expansion state is tracked separately so that re-computing vmLines
  // (e.g., when context size changes) doesn't blow away user expansions.
  private expandedIds = signal<Set<number>>(new Set());

  // ── Find-in-results computed matches ──────────────────────────────

  findMatches = computed<number[]>(() => {
    const term = this.findTerm().trim().toLowerCase();
    if (!term) return [];
    const hits: number[] = [];
    for (const l of this.vmLines()) {
      if (l.kind !== 'line') continue;
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

  // ── Other derived ─────────────────────────────────────────────────
  canSearch = computed(() =>
    !!this.selectedEnvName() &&
    this.searchTerm().trim().length > 0 &&
    !this.isSearching()
  );

  selectedEnv = computed<EnvOption | null>(() => {
    const name = this.selectedEnvName();
    return this.envs().find(e => e.name === name) || null;
  });

  // Count of match-lines currently visible in the VM.
  visibleMatchCount = computed(() => this.vmLines().filter(l => l.kind === 'line' && l.isMatch).length);

  constructor() {
    effect(() => {
      const count = this.findMatchCount();
      this.currentMatchIndex.set(count > 0 ? 0 : -1);
    }, { allowSignalWrites: true });

    effect(() => {
      const idx = this.currentMatchIndex();
      const matches = this.findMatches();
      if (idx < 0 || idx >= matches.length) return;
      const lineId = matches[idx];
      queueMicrotask(() => this.scrollMatchIntoView(lineId));
    });
  }

  ngOnInit(): void {
    this.loadEnvs();
  }

  private loadEnvs(): void {
    this.isLoadingEnvs.set(true);
    this.envsError.set('');
    this.logService.getEnvs().subscribe({
      next: (envs) => {
        this.envs.set(envs);
        if (envs.length > 0 && !this.selectedEnvName()) {
          this.selectedEnvName.set(envs[0].name);
        }
        this.isLoadingEnvs.set(false);
      },
      error: (err) => {
        this.envsError.set(err?.error?.error || err?.message || 'Failed to load environments');
        this.isLoadingEnvs.set(false);
      }
    });
  }

  onRefreshEnvs(): void {
    this.loadEnvs();
  }

  onSearch(): void {
    const env = this.selectedEnv();
    const term = this.searchTerm().trim();
    if (!env || !term) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.rawEntries.set([]);
    this.totalMatched.set(0);
    this.matchesReturned.set(0);
    this.truncated.set(false);
    this.hasSearched.set(true);
    this.lastSearchedTerm.set(term);
    this.findTerm.set('');
    this.currentMatchIndex.set(-1);
    this.expandedIds.set(new Set());

    this.logService.searchLogs({ logUrl: env.applicationLogsUrl, reqId: term }).subscribe({
      next: (response) => {
        this.rawEntries.set(response.lines || []);
        this.totalMatched.set(response.totalMatched || 0);
        this.matchesReturned.set(response.matchesReturned || 0);
        this.truncated.set(!!response.truncated);
        this.serverContextSize.set(response.contextSize || 0);
        this.isSearching.set(false);
      },
      error: (err) => {
        this.searchError.set(err?.error?.error || err?.message || 'Failed to search logs');
        this.isSearching.set(false);
      }
    });
  }

  onContextSizeChange(value: number | string): void {
    const n = typeof value === 'string' ? parseInt(value, 10) : value;
    if ((CONTEXT_CHOICES as readonly number[]).includes(n)) {
      this.contextSize.set(n as ContextSize);
    }
  }

  // ── Expand / collapse handlers ─────────────────────────────────────

  isExpanded(id: number): boolean {
    return this.expandedIds().has(id);
  }

  onLineMouseup(id: number, line: LineVM): void {
    if (line.kind !== 'line' || !line.parsed) return;
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
      if (l.kind === 'line' && l.parsed) all.add(l.id);
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

  isFindMatch(id: number): boolean {
    return this.findMatches().indexOf(id) !== -1;
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

  highlight(text: string): string {
    let safe = this.escapeHtml(text);
    const primary = this.lastSearchedTerm();
    if (primary) {
      const re = new RegExp(this.escapeRegex(this.escapeHtml(primary)), 'g');
      safe = safe.replace(re, '<mark class="log-hl-primary">$&</mark>');
    }
    const find = this.findTerm().trim();
    if (find) {
      const re = new RegExp(this.escapeRegex(this.escapeHtml(find)), 'gi');
      safe = safe.replace(re, '<mark class="log-hl-find">$&</mark>');
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

  // Template type guards
  isLineKind(v: LineVM): v is Extract<LineVM, { kind: 'line' }> {
    return v.kind === 'line';
  }
}
