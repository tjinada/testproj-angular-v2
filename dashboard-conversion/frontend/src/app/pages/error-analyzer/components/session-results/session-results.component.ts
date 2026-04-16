import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SessionEvent,
  SessionPageGroup,
  SessionSummary,
  UserEventRecord
} from '../../models/trace.model';
import { SessionAnalyzer } from '../../services/session-analyzer';

@Component({
  selector: 'app-session-results',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './session-results.component.html',
  styleUrls: ['./session-results.component.scss']
})
export class SessionResultsComponent implements OnChanges {
  @Input() events: UserEventRecord[] = [];
  @Input() isLoading = false;
  @Input() errorMsg = '';

  @Output() findTraces = new EventEmitter<{ urlFull: string; eventStartTime: string }>();

  summary: SessionSummary | null = null;
  pageGroups: SessionPageGroup[] = [];

  selectedPageGroupIndex = 0;
  selectedEventKey: string | null = null;
  selectedEvent: SessionEvent | null = null;
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

    const firstErrorIdx = this.pageGroups.findIndex(g => this.groupHasErrors(g));
    this.selectedPageGroupIndex = firstErrorIdx >= 0 ? firstErrorIdx : 0;
    this.selectedEventKey = null;
    this.selectedEvent = null;
    this.tracesActiveEventKey = null;
  }

  selectPageGroup(index: number): void {
    if (index === this.selectedPageGroupIndex) return;
    this.selectedPageGroupIndex = index;
    this.selectedEventKey = null;
    this.selectedEvent = null;
  }

  isPageGroupSelected(index: number): boolean {
    return this.selectedPageGroupIndex === index;
  }

  get selectedPageGroup(): SessionPageGroup | null {
    if (this.pageGroups.length === 0) return null;
    return this.pageGroups[this.selectedPageGroupIndex] || null;
  }

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

  isEventTracesActive(groupIdx: number, eventIdx: number): boolean {
    return this.tracesActiveEventKey === `${groupIdx}:${eventIdx}`;
  }

  onFindTracesClick(eventIdx: number, event: SessionEvent, mouseEvent: MouseEvent): void {
    mouseEvent.stopPropagation();
    if (!event.urlFull) return;

    this.tracesActiveEventKey = `${this.selectedPageGroupIndex}:${eventIdx}`;

    const stripped = event.urlFull.split('?')[0].split('#')[0];
    this.findTraces.emit({
      urlFull: stripped,
      eventStartTime: event.startTime
    });
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
    return Math.max(innerErrors, summaryErrors);
  }

  private static readonly SLOW_NANOS = 1_000_000_000;
  private static readonly VERY_SLOW_NANOS = 3_000_000_000;

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

  formatDuration(nanos: number): string {
    if (!nanos) return '—';
    if (nanos < 1_000_000) return `${Math.round(nanos / 1000)}µs`;
    if (nanos < 1_000_000_000) return `${Math.round(nanos / 1_000_000)}ms`;
    return `${(nanos / 1_000_000_000).toFixed(2)}s`;
  }

  formatRelative(ms: number): string {
    if (!ms) return '+00:00.000';
    const totalSec = Math.floor(ms / 1000);
    const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const ss = (totalSec % 60).toString().padStart(2, '0');
    const mmm = Math.floor(ms % 1000).toString().padStart(3, '0');
    return `+${mm}:${ss}.${mmm}`;
  }

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
