import { ChangeDetectionStrategy, Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LogService } from '../../services/log.service';
import { EnvOption } from '../../models/log.model';

/** Parsed representation of a single log line. */
interface ParsedLogLine {
  raw: string;
  parsed: boolean;
  // Populated when `parsed === true`:
  timestamp?: string;      // e.g., "17:18:41.656"
  level?: string;          // e.g., "DEBUG"
  shortClass?: string;     // last segment of class, e.g., "ChannelServiceDispatchServlet"
  message?: string;        // everything after the final " - "
  prefix?: string;         // hidden-by-default portion (thread + full class + metadata)
}

interface LogLineVM extends ParsedLogLine {
  id: number;
  expanded: boolean;
}

// Regex targets lines like:
//   2026-04-22 11:00:39.817 -0400 [WebContainer : 15] DEBUG com.bmo.cs.controller.Foo IP=[...] ... REQID=[...] - message text
// Capture groups:
//   1 = timestamp (full date + time + timezone)
//   2 = thread bracket content (e.g., "WebContainer : 15")
//   3 = level
//   4 = class path
//   5 = the prefix metadata block (IP=..., SESSION=..., etc.) — may be empty
//   6 = message (after final " - ")
const LINE_REGEX =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}(?:\s+[-+]\d{4})?)\s+\[([^\]]+)\]\s+(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\s+([\w.$]+)\s+(.*?)\s-\s(.*)$/;

function parseLine(raw: string): ParsedLogLine {
  const m = LINE_REGEX.exec(raw);
  if (!m) {
    return { raw, parsed: false };
  }
  const [, timestamp, thread, level, fullClass, metadata, message] = m;
  const shortClass = fullClass.includes('.')
    ? fullClass.split('.').pop()!
    : fullClass;
  // Rebuild the hidden prefix exactly as it appeared between level and " - ".
  const prefix = `[${thread}] ${fullClass}${metadata ? ' ' + metadata : ''}`;
  return {
    raw,
    parsed: true,
    timestamp,
    level: level.toUpperCase(),
    shortClass,
    message,
    prefix
  };
}

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

  // ── Env dropdown state ────────────────────────────────────────────
  envs = signal<EnvOption[]>([]);
  selectedEnvName = signal<string>('');
  isLoadingEnvs = signal<boolean>(false);
  envsError = signal<string>('');

  // ── Search state ──────────────────────────────────────────────────
  reqId = signal<string>('');
  isSearching = signal<boolean>(false);
  searchError = signal<string>('');
  rawLines = signal<string[]>([]);
  totalMatched = signal<number>(0);
  truncated = signal<boolean>(false);
  hasSearched = signal<boolean>(false);
  lastSearchedReqId = signal<string>('');

  // ── View-model for rendered lines ─────────────────────────────────
  vmLines = signal<LogLineVM[]>([]);

  // ── Derived ───────────────────────────────────────────────────────
  canSearch = computed(() =>
    !!this.selectedEnvName() &&
    this.reqId().trim().length > 0 &&
    !this.isSearching()
  );

  selectedEnv = computed<EnvOption | null>(() => {
    const name = this.selectedEnvName();
    return this.envs().find(e => e.name === name) || null;
  });

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
    const id = this.reqId().trim();
    if (!env || !id) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.rawLines.set([]);
    this.vmLines.set([]);
    this.totalMatched.set(0);
    this.truncated.set(false);
    this.hasSearched.set(true);
    this.lastSearchedReqId.set(id);

    this.logService.searchLogs({ logUrl: env.applicationLogsUrl, reqId: id }).subscribe({
      next: (response) => {
        const raw = response.lines || [];
        this.rawLines.set(raw);
        this.vmLines.set(
          raw.map((line, idx) => ({
            ...parseLine(line),
            id: idx,
            expanded: false
          }))
        );
        this.totalMatched.set(response.totalMatched || 0);
        this.truncated.set(!!response.truncated);
        this.isSearching.set(false);
      },
      error: (err) => {
        this.searchError.set(err?.error?.error || err?.message || 'Failed to search logs');
        this.isSearching.set(false);
      }
    });
  }

  // ── Expand / collapse handlers ─────────────────────────────────────

  /**
   * Toggle on mouseup — but only if the user didn't make a text selection.
   * This lets users select/copy text without triggering a toggle.
   */
  onLineMouseup(id: number): void {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (sel && sel.toString().length > 0) {
      return;
    }
    this.toggleLine(id);
  }

  toggleLine(id: number): void {
    this.vmLines.update(lines =>
      lines.map(l => (l.id === id ? { ...l, expanded: !l.expanded } : l))
    );
  }

  expandAll(): void {
    this.vmLines.update(lines => lines.map(l => ({ ...l, expanded: true })));
  }

  collapseAll(): void {
    this.vmLines.update(lines => lines.map(l => ({ ...l, expanded: false })));
  }

  trackById(_index: number, line: { id: number }): number {
    return line.id;
  }

  // ── Search-term highlighting ──────────────────────────────────────

  /**
   * Escapes HTML, then wraps occurrences of `needle` in a highlight span.
   * Used by the template via [innerHTML].
   */
  highlight(text: string, needle: string): string {
    const safe = this.escapeHtml(text);
    if (!needle) return safe;
    const safeNeedle = this.escapeHtml(needle);
    // Escape regex metacharacters in the (already HTML-escaped) needle.
    const re = new RegExp(this.escapeRegex(safeNeedle), 'g');
    return safe.replace(re, '<mark class="log-hl">$&</mark>');
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
