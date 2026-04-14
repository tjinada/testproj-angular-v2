import {
  UserEventRecord,
  SessionSummary,
  SessionEvent,
  SessionEventKind,
  SessionPageGroup
} from '../models/trace.model';

/**
 * Classifies a raw user.events record into one of the known event kinds.
 * Returns null for events that don't fit any category (they're ignored).
 *
 * We rely on the characteristics.* flags rather than event IDs because
 * Grail RUM event shapes vary by agent config and version.
 */
function classifyEvent(r: UserEventRecord): 'page_view' | SessionEventKind | null {
  const classifier = String(r['characteristics.classifier'] ?? '');
  if (classifier === 'view_summary' || r['characteristics.has_view_summary'] === true) {
    return 'page_view';
  }
  if (classifier === 'user_action' || r['characteristics.has_user_action'] === true) {
    return 'user_action';
  }
  if (
    r['characteristics.has_error'] === true ||
    r['characteristics.has_failed_request'] === true ||
    r['characteristics.has_csp_violation'] === true ||
    classifier === 'error'
  ) {
    return 'error';
  }
  if (r['characteristics.has_request'] === true) {
    return 'request';
  }
  return null;
}

/** Safe string getter — treats null/undefined as empty string. */
function str(r: UserEventRecord, key: string): string {
  const v = r[key];
  return v === null || v === undefined ? '' : String(v);
}

/** Safe number getter — treats null/undefined/non-numeric as 0. */
function num(r: UserEventRecord, key: string): number {
  const v = r[key];
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/**
 * Stateful analyzer for a single RUM session. Takes raw user.events records
 * and produces a session summary and a grouped list of page views with
 * their inner events nested inside.
 */
export class SessionAnalyzer {
  private readonly sorted: UserEventRecord[];
  private readonly sessionStartMs: number;
  private readonly sessionEndMs: number;

  constructor(private readonly events: UserEventRecord[]) {
    this.sorted = [...events].sort(
      (a, b) => this.startMs(a) - this.startMs(b)
    );

    if (this.sorted.length === 0) {
      this.sessionStartMs = 0;
      this.sessionEndMs = 0;
      return;
    }

    this.sessionStartMs = this.startMs(this.sorted[0]);

    // End time = max(end_time | start_time) across all events
    let maxEnd = this.sessionStartMs;
    for (const r of this.sorted) {
      const endStr = str(r, 'end_time');
      const endMs = endStr ? new Date(endStr).getTime() : this.startMs(r);
      if (endMs > maxEnd) maxEnd = endMs;
    }
    this.sessionEndMs = maxEnd;
  }

  /**
   * Builds the one-time session-level summary from whichever event has each
   * field populated. Session-level fields (browser, OS, geo, IP, etc.) are
   * repeated on every event but some events have more populated than others,
   * so we walk until we find a non-empty value.
   */
  getSummary(): SessionSummary {
    const firstNonEmpty = (key: string): string => {
      for (const r of this.sorted) {
        const v = str(r, key);
        if (v) return v;
      }
      return '';
    };

    const browserName = firstNonEmpty('browser.name');
    const browserVersion = firstNonEmpty('browser.version');
    const browser = browserName
      ? (browserVersion ? `${browserName} ${browserVersion}` : browserName)
      : '';

    let pageViewCount = 0;
    let userActionCount = 0;
    let errorCount = 0;
    for (const r of this.sorted) {
      const kind = classifyEvent(r);
      if (kind === 'page_view') pageViewCount++;
      else if (kind === 'user_action') userActionCount++;
      else if (kind === 'error') errorCount++;
    }

    return {
      sessionId: firstNonEmpty('dt.rum.session.id'),
      startTime: this.sessionStartMs ? new Date(this.sessionStartMs).toISOString() : '',
      endTime: this.sessionEndMs ? new Date(this.sessionEndMs).toISOString() : '',
      durationMs: Math.max(0, this.sessionEndMs - this.sessionStartMs),
      browser,
      os: firstNonEmpty('os.name'),
      deviceType: firstNonEmpty('device.type'),
      country: firstNonEmpty('geo.country.iso_code'),
      clientIp: firstNonEmpty('client.ip'),
      isp: firstNonEmpty('client.isp'),
      appName: firstNonEmpty('frontend.name') || firstNonEmpty('dt.rum.application.entity'),
      pageViewCount,
      userActionCount,
      errorCount
    };
  }

  /**
   * Groups events by page view. Each group contains the page view itself
   * plus all user actions and errors that happened on that page, in
   * chronological order. Events that occur before any page view are
   * attached to a synthetic "before first page" group if needed; events
   * with no page context are attached to the nearest preceding page.
   */
  getPageGroups(): SessionPageGroup[] {
    const groups: SessionPageGroup[] = [];
    let currentGroup: SessionPageGroup | null = null;

    for (const r of this.sorted) {
      const kind = classifyEvent(r);
      if (kind === null) continue;

      if (kind === 'page_view') {
        currentGroup = this.buildPageGroup(r);
        groups.push(currentGroup);
        continue;
      }

      // Non-page-view event. Attach to the current group, or create a
      // synthetic "session start" group if we haven't seen a page view yet.
      if (!currentGroup) {
        currentGroup = this.buildSyntheticGroup(r);
        groups.push(currentGroup);
      }

      const event = this.buildSessionEvent(r, kind);
      if (event) currentGroup.events.push(event);
    }

    return groups;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private startMs(r: UserEventRecord): number {
    const s = str(r, 'start_time');
    if (!s) return 0;
    const ms = new Date(s).getTime();
    return isNaN(ms) ? 0 : ms;
  }

  private relativeMs(r: UserEventRecord): number {
    return Math.max(0, this.startMs(r) - this.sessionStartMs);
  }

  private buildPageGroup(r: UserEventRecord): SessionPageGroup {
    // For SPAs, view.* fields update on router navigations while page.* fields
    // stay constant for the whole session (the document never reloads). Prefer
    // view.* so each router navigation shows up as a distinct page group.
    const pageName =
      str(r, 'view.name') || str(r, 'view.detected_name') ||
      str(r, 'view.url.path') || str(r, 'page.name') || str(r, 'page.url.path') ||
      '(unknown page)';

    const pageUrlFull =
      str(r, 'view.url.full') || str(r, 'page.url.full') || '';

    // page.title is the document <title> which is static for SPAs (e.g. always
    // "Sign in - BMO" even after navigating to /accounts). Only show it when it
    // adds information — i.e. when it isn't equivalent to the page name.
    const rawTitle = str(r, 'page.title');
    const pageTitle = rawTitle && rawTitle !== pageName ? rawTitle : '';

    return {
      pageName,
      pageTitle,
      pageUrlFull,
      startTime: str(r, 'start_time'),
      relativeMs: this.relativeMs(r),
      durationNanos: num(r, 'duration'),
      webVitals: {
        lcp: str(r, 'lcp.status'),
        fcp: str(r, 'fcp.status'),
        fid: str(r, 'fid.status'),
        cls: str(r, 'cls.status'),
        clsValue: str(r, 'cls.value'),
        inpDurationMs: Math.round(num(r, 'inp.duration') / 1_000_000)
      },
      errorCounts: {
        http4xx: num(r, 'error.http_4xx_count'),
        http5xx: num(r, 'error.http_5xx_count'),
        exception: num(r, 'error.exception_count'),
        cspViolation: num(r, 'error.csp_violation_count')
      },
      events: []
    };
  }

  /**
   * Creates a synthetic group for events that arrive before any page view.
   * Labels it as "Session start" so the UI has somewhere to put them.
   */
  private buildSyntheticGroup(r: UserEventRecord): SessionPageGroup {
    return {
      pageName: '(session start)',
      pageTitle: '',
      pageUrlFull: '',
      startTime: str(r, 'start_time'),
      relativeMs: this.relativeMs(r),
      durationNanos: 0,
      webVitals: {
        lcp: '', fcp: '', fid: '', cls: '', clsValue: '', inpDurationMs: 0
      },
      errorCounts: { http4xx: 0, http5xx: 0, exception: 0, cspViolation: 0 },
      events: []
    };
  }

  private buildSessionEvent(r: UserEventRecord, kind: SessionEventKind): SessionEvent | null {
    return {
      kind,
      startTime: str(r, 'start_time'),
      relativeMs: this.relativeMs(r),
      durationNanos: num(r, 'duration'),
      label: this.buildLabel(r, kind),
      isFailed: this.isFailedEvent(r, kind),
      urlFull: str(r, 'url.full'),
      httpStatus: str(r, 'http.response.status_code'),
      raw: r
    };
  }

  /**
   * Builds a human-readable one-line label for the event. Kept short so it
   * fits in a dense list. Detail panel surfaces everything else.
   */
  private buildLabel(r: UserEventRecord, kind: SessionEventKind): string {
    if (kind === 'user_action') {
      const actionType = str(r, 'user_action.type');              // e.g. "xhr", "load", "click"
      const interaction = str(r, 'interaction.name');              // e.g. "click", "pointerup"
      const tag = str(r, 'ui_element.tag_name');                   // e.g. "BUTTON"
      const requestCount = num(r, 'user_action.requests.count');
      const urlFull = str(r, 'url.full');

      const parts: string[] = [];
      if (interaction) parts.push(interaction);
      else if (actionType) parts.push(actionType);
      if (tag) parts.push(`[${tag.toLowerCase()}]`);
      if (urlFull) parts.push(`\u2192 ${this.shortUrl(urlFull)}`);
      if (requestCount > 0) parts.push(`(${requestCount} req${requestCount === 1 ? '' : 's'})`);
      return parts.join(' ') || 'user action';
    }

    if (kind === 'error') {
      const errorType = str(r, 'error.type');
      const errorReason = str(r, 'error.reason');
      const displayName = str(r, 'error.display_name');
      const httpStatus = str(r, 'http.response.status_code');

      if (displayName) return `error: ${displayName}`;
      if (errorReason === 'csp') return `CSP violation${errorType ? `: ${errorType}` : ''}`;
      if (httpStatus && (httpStatus.startsWith('4') || httpStatus.startsWith('5'))) {
        return `HTTP ${httpStatus} error`;
      }
      if (errorType) return `error: ${errorType}`;
      return 'error';
    }

    // kind === 'request'
    const urlFull = str(r, 'url.full');
    const status = str(r, 'http.response.status_code');
    if (urlFull && status) return `${status} ${this.shortUrl(urlFull)}`;
    if (urlFull) return this.shortUrl(urlFull);
    return 'request';
  }

  private isFailedEvent(r: UserEventRecord, kind: SessionEventKind): boolean {
    if (kind === 'error') return true;
    if (r['characteristics.has_failed_request'] === true) return true;
    if (r['characteristics.has_error'] === true) return true;
    const status = str(r, 'http.response.status_code');
    if (status && (status.startsWith('4') || status.startsWith('5'))) return true;
    return false;
  }

  /** Strips scheme + optional host, returns path only (or last 50 chars). */
  private shortUrl(full: string): string {
    if (!full) return '';
    const noScheme = full.replace(/^https?:\/\//i, '');
    const slashIdx = noScheme.indexOf('/');
    const path = slashIdx >= 0 ? noScheme.substring(slashIdx) : noScheme;
    if (path.length <= 50) return path;
    return path.substring(0, 47) + '...';
  }
}
