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
 * Displays a RUM session as a header card plus a split view: page groups
 * on the left, events for the selected page on the right, detail panel at
 * the bottom. The card has a fixed total height; left and right sides
 * scroll independently, so expanding a 100-event page never pushes the
 * trace results table off-screen.
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

  /** Emitted when the user clicks the "Trace" button on an event. */
  @Output() findTraces = new EventEmitter<{ urlFull: string; eventStartTime: string }>();

  summary: SessionSummary | null = null;
  pageGroups: SessionPageGroup[] = [];

  /** Index of currently selected page group on the left. Always set to a
   *  valid index when pageGroups has entries; never null while data loaded. */
  selectedPageGroupIndex = 0;

  /** Composite key "groupIdx:eventIdx" of currently selected event (for the
   *  detail panel). Null when no event is selected. */
  selectedEventKey: string | null = null;
  selectedEvent: SessionEvent | null = null;

  /** Composite key of the event whose "Trace" button was last clicked. The
   *  row gets a persistent blue highlight so the user can navigate around
   *  and still know which event the trace results below correspond to. */
  tracesActiveEventKey: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['events']) {
      this.analyzeSession();
    }
  }

  private analyzeSession(): void {
    if (!this.events || this.events.length === 0) {
      this.summary = null;
      this.pageGroups = [];
      this.selectedPageGroupIndex = 0;
      this.selectedEventKey = null;
      this.selectedEvent = null;
      this.tracesActiveEventKey = null;
      return;
    }

    const analyzer = new SessionAnalyzer(this.events);
    this.summary = analyzer.getSummary();
    this.pageGroups = analyzer.getPageGroups();

    // Auto-select the first page group with errors so the user lands on
    // the most interesting page. Falls back to the first page if no errors.
    const firstErrorIdx = this.pageGroups.findIndex(g => this.groupHasErrors(g));
    this.selectedPageGroupIndex = firstErrorIdx >= 0 ? firstErrorIdx : 0;
    this.selectedEventKey = null;
    this.selectedEvent = null;
    this.tracesActiveEventKey = null;
  }

  // ------------------------------------------------------------------
  // Page group selection (left column)
  // ------------------------------------------------------------------

  selectPageGroup(index: number): void {
    if (index === this.selectedPageGroupIndex) return;
    this.selectedPageGroupIndex = index;
    // Clear the selected event when switching pages — the detail panel
    // should always show an event from the currently-viewed page.
    this.selectedEventKey = null;
    this.selectedEvent = null;
  }

  isPageGroupSelected(index: number): boolean {
    return this.selectedPageGroupIndex === index;
  }

  /** Returns the currently selected page group, or null if none. */
  get selectedPageGroup(): SessionPageGroup | null {
    if (this.pageGroups.length === 0) return null;
    return this.pageGroups[this.selectedPageGroupIndex] || null;
  }

  // ------------------------------------------------------------------
  // Event selection (right column)
  // ------------------------------------------------------------------

  onEventClick(eventIdx: number, event: SessionEvent): void {
    const key = `${this.selectedPageGroupIndex}:${eventIdx}`;
    if (this.selectedEventKey === key) {
      this.selectedEventKey = null;
      this.selectedEvent = null;
      return;
    }
    this.selectedEventKey = key;
    this.selectedEvent = event;
  }

  isEventSelected(eventIdx: number): boolean {
    return this.selectedEventKey === `${this.selectedPageGroupIndex}:${eventIdx}`;
  }

  /** True when this event's row should show the persistent "I'm investigating
   *  this one" blue highlight. Set by clicking the Trace button. */
  isEventTracesActive(groupIdx: number, eventIdx: number): boolean {
    return this.tracesActiveEventKey === `${groupIdx}:${eventIdx}`;
  }

  onFindTracesClick(eventIdx: number, event: SessionEvent, mouseEvent: MouseEvent): void {
    mouseEvent.stopPropagation();
    if (!event.urlFull) return;

    // Mark this event as the active "investigation target". Persists until
    // a different Trace click or a new session search.
    this.tracesActiveEventKey = `${this.selectedPageGroupIndex}:${eventIdx}`;

    // Strip query strings before searching. Backend spans store url.path
    // without query params, so passing the full URL with ?StateId=... never
    // matches. We want to find every trace that hit the same endpoint
    // regardless of per-request parameters.
    const stripped = event.urlFull.split('?')[0].split('#')[0];
    this.findTraces.emit({
      urlFull: stripped,
      eventStartTime: event.startTime
    });
  }

  // ------------------------------------------------------------------
  // Page group helpers
  // ------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // Slow event classification
  // ------------------------------------------------------------------

  /** Slow-request thresholds. Events with duration above these bounds get
   *  amber / red highlighting so performance issues are visually obvious. */
  private static readonly SLOW_NANOS = 1_000_000_000;       // 1s
  private static readonly VERY_SLOW_NANOS = 3_000_000_000;  // 3s

  /** Extensions and host fragments that identify static assets for which
   *  a Trace button would be pointless. */
  private static readonly STATIC_ASSET_EXT_RE =
    /\.(js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|ico|webp|bmp|map)(\?|$|#)/i;
  private static readonly STATIC_ASSET_HOST_FRAGMENTS = [
    'cdn.cookielaw.org',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
  ];

  isSlow(ev: SessionEvent): boolean {
    return ev.durationNanos >= SessionResultsComponent.SLOW_NANOS
      && ev.durationNanos < SessionResultsComponent.VERY_SLOW_NANOS;
  }

  isVerySlow(ev: SessionEvent): boolean {
    return ev.durationNanos >= SessionResultsComponent.VERY_SLOW_NANOS;
  }

  private isStaticAsset(ev: SessionEvent): boolean {
    const url = (ev.urlFull || '').toLowerCase();
    if (!url) return false;
    if (SessionResultsComponent.STATIC_ASSET_EXT_RE.test(url)) return true;
    for (const frag of SessionResultsComponent.STATIC_ASSET_HOST_FRAGMENTS) {
      if (url.includes(frag)) return true;
    }
    return false;
  }

  canFindBackendTraces(ev: SessionEvent): boolean {
    if (!ev.urlFull) return false;
    if (ev.kind !== 'user_action' && ev.kind !== 'request') return false;
    if (this.isStaticAsset(ev)) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  /** Formats nanoseconds to a short duration string (e.g. "84ms", "4.38s"). */
  formatDuration(nanos: number): string {
    if (!nanos) return '—';
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(2)}s`;
  }

  /** Formats a relative offset in ms as +mm:ss.SSS */
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

  /** Full localized timestamp for the session header (with date). */
  formatTimestamp(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  /** Time-of-day only, used in the two-line time display next to events
   *  and page groups. e.g. "09:48:17 p.m." */
  formatTimeOfDay(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-CA', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  eventIcon(kind: string): string {
    if (kind === 'user_action') return '▶';
    if (kind === 'error') return '✕';
    if (kind === 'request') return '⇄';
    return '•';
  }

  trackGroup = (_: number, g: SessionPageGroup) => `${g.startTime}|${g.pageName}`;
  trackEvent = (_: number, e: SessionEvent) => `${e.startTime}|${e.label}`;

  // ------------------------------------------------------------------
  // Detail panel
  // ------------------------------------------------------------------

  selectedEventKeys(): string[] {
    if (!this.selectedEvent) return [];
    return Object.keys(this.selectedEvent.raw)
      .filter(k => {
        const v = this.selectedEvent!.raw[k];
        return v !== null && v !== undefined && v !== '';
      })
      .sort();
  }

  selectedEventValue(key: string): string {
    if (!this.selectedEvent) return '';
    const v = this.selectedEvent.raw[key];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
}
