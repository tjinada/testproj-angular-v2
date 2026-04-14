import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SessionEvent,
  SessionPageGroup,
  SessionSummary,
  UserEventRecord
} from '../../models/trace.model';
import { SessionAnalyzer } from '../../services/session-analyzer';

/**
 * Displays a RUM session as a header card plus a list of page view groups.
 * Each page group is collapsible; the first is expanded by default.
 *
 * Phase 1 uses a list layout. Phase 2 will swap the list for an SVG
 * timeline while keeping the same analyzer output.
 */
@Component({
  selector: 'app-session-results',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './session-results.component.html',
  styleUrls: ['./session-results.component.css']
})
export class SessionResultsComponent implements OnChanges {
  @Input() events: UserEventRecord[] = [];
  @Input() isLoading = false;
  @Input() errorMsg = '';

  /** Emitted when the user clicks "Find backend traces" on a user action. */
  @Output() findTraces = new EventEmitter<string>();

  summary: SessionSummary | null = null;
  pageGroups: SessionPageGroup[] = [];

  /** Index of currently expanded page group. First group is expanded by default. */
  expandedGroupIndex: number | null = null;

  /** Composite key of currently selected event (for the detail panel). */
  selectedEventKey: string | null = null;
  selectedEvent: SessionEvent | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['events']) {
      this.analyzeSession();
    }
  }

  private analyzeSession(): void {
    if (!this.events || this.events.length === 0) {
      this.summary = null;
      this.pageGroups = [];
      this.expandedGroupIndex = null;
      this.selectedEventKey = null;
      this.selectedEvent = null;
      return;
    }

    const analyzer = new SessionAnalyzer(this.events);
    this.summary = analyzer.getSummary();
    this.pageGroups = analyzer.getPageGroups();

    // Expand the first page group by default. Auto-expand any group that
    // contains errors so problems are immediately visible.
    const firstErrorIdx = this.pageGroups.findIndex(
      g => g.events.some(e => e.isFailed) ||
           g.errorCounts.http4xx > 0 || g.errorCounts.http5xx > 0 ||
           g.errorCounts.exception > 0
    );
    this.expandedGroupIndex = firstErrorIdx >= 0 ? firstErrorIdx : 0;
    this.selectedEventKey = null;
    this.selectedEvent = null;
  }

  toggleGroup(index: number): void {
    this.expandedGroupIndex = this.expandedGroupIndex === index ? null : index;
  }

  isGroupExpanded(index: number): boolean {
    return this.expandedGroupIndex === index;
  }

  onEventClick(groupIdx: number, eventIdx: number, event: SessionEvent): void {
    const key = `${groupIdx}:${eventIdx}`;
    if (this.selectedEventKey === key) {
      this.selectedEventKey = null;
      this.selectedEvent = null;
      return;
    }
    this.selectedEventKey = key;
    this.selectedEvent = event;
  }

  isEventSelected(groupIdx: number, eventIdx: number): boolean {
    return this.selectedEventKey === `${groupIdx}:${eventIdx}`;
  }

  onFindTracesClick(event: SessionEvent, mouseEvent: MouseEvent): void {
    mouseEvent.stopPropagation();
    if (event.urlFull) {
      // Strip query strings before searching. Backend spans store url.path
      // without query params, so passing the full URL with ?StateId=... never
      // matches. We want the search to find every trace that hit the same
      // endpoint regardless of per-request parameters.
      const stripped = event.urlFull.split('?')[0].split('#')[0];
      this.findTraces.emit(stripped);
    }
  }

  groupHasErrors(group: SessionPageGroup): boolean {
    if (group.events.some(e => e.isFailed)) return true;
    return group.errorCounts.http4xx > 0 ||
           group.errorCounts.http5xx > 0 ||
           group.errorCounts.exception > 0;
  }

  groupErrorCount(group: SessionPageGroup): number {
    const innerErrors = group.events.filter(e => e.isFailed).length;
    const summaryErrors =
      group.errorCounts.http4xx +
      group.errorCounts.http5xx +
      group.errorCounts.exception +
      group.errorCounts.cspViolation;
    // The page view's error counters already sum the inner errors, so take the max.
    return Math.max(innerErrors, summaryErrors);
  }

  /** Slow-request thresholds. Events with duration above these bounds get
   *  amber / red highlighting so performance issues are visually obvious. */
  private static readonly SLOW_NANOS = 1_000_000_000;       // 1s
  private static readonly VERY_SLOW_NANOS = 3_000_000_000;  // 3s

  /** Extensions and host fragments that identify static assets for which
   *  a "Find backend traces" button would be pointless. Kept deliberately
   *  conservative — anything that might be a real API call passes through. */
  private static readonly STATIC_ASSET_EXT_RE =
    /\.(js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|ico|webp|bmp|map)(\?|$|#)/i;
  private static readonly STATIC_ASSET_HOST_FRAGMENTS = [
    'cdn.cookielaw.org',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
  ];

  /** True when the event took longer than 1s (but not yet 3s). */
  isSlow(ev: SessionEvent): boolean {
    return ev.durationNanos >= SessionResultsComponent.SLOW_NANOS
      && ev.durationNanos < SessionResultsComponent.VERY_SLOW_NANOS;
  }

  /** True when the event took longer than 3s. */
  isVerySlow(ev: SessionEvent): boolean {
    return ev.durationNanos >= SessionResultsComponent.VERY_SLOW_NANOS;
  }

  /**
   * True when the event's URL is clearly a static asset (JS/CSS/font/image
   * bundles, source maps, known CDN hosts). Used to suppress the "Find
   * backend traces" button on requests where searching would be pointless.
   */
  private isStaticAsset(ev: SessionEvent): boolean {
    const url = (ev.urlFull || '').toLowerCase();
    if (!url) return false;
    if (SessionResultsComponent.STATIC_ASSET_EXT_RE.test(url)) return true;
    for (const frag of SessionResultsComponent.STATIC_ASSET_HOST_FRAGMENTS) {
      if (url.includes(frag)) return true;
    }
    return false;
  }

  /**
   * True when the event should show a "Find backend traces" button. Applies
   * to user actions and plain request events that have a URL and aren't
   * clearly static assets.
   */
  canFindBackendTraces(ev: SessionEvent): boolean {
    if (!ev.urlFull) return false;
    if (ev.kind !== 'user_action' && ev.kind !== 'request') return false;
    if (this.isStaticAsset(ev)) return false;
    return true;
  }

  /** For the "Duration" column — formats nanoseconds into a short string. */
  formatDuration(nanos: number): string {
    if (!nanos) return '—';
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(2)}s`;
  }

  /** Formats a relative offset in ms as mm:ss.SSS */
  formatRelative(ms: number): string {
    if (!ms) return '+00:00.000';
    const totalSec = Math.floor(ms / 1000);
    const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const ss = (totalSec % 60).toString().padStart(2, '0');
    const mmm = Math.floor(ms % 1000).toString().padStart(3, '0');
    return `+${mm}:${ss}.${mmm}`;
  }

  /** Formats session duration in ms as a human string (e.g. "39.8s", "2m 15s"). */
  formatSessionDuration(ms: number): string {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m ${sec}s`;
  }

  formatTimestamp(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  /** Icon character per event kind. Text-based so no icon library needed. */
  eventIcon(kind: string): string {
    if (kind === 'user_action') return '▶';
    if (kind === 'error') return '✕';
    if (kind === 'request') return '⇄';
    return '•';
  }

  trackGroup = (_: number, g: SessionPageGroup) => `${g.startTime}|${g.pageName}`;
  trackEvent = (_: number, e: SessionEvent) => `${e.startTime}|${e.label}`;

  /** Returns the keys of the selected event's raw record, for the detail panel. */
  selectedEventKeys(): string[] {
    if (!this.selectedEvent) return [];
    return Object.keys(this.selectedEvent.raw)
      .filter(k => {
        const v = this.selectedEvent!.raw[k];
        return v !== null && v !== undefined && v !== '';
      })
      .sort();
  }

  /** Looks up a field on the selected event's raw record. */
  selectedEventValue(key: string): string {
    if (!this.selectedEvent) return '';
    const v = this.selectedEvent.raw[key];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
}
