import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { UrlTraceService } from '../../services/url-trace.service';
import { parseHeaderBlob } from '../../models/url-trace.model';
import type { UrlTraceError, UrlTraceResponse } from '../../models/url-trace.model';

/**
 * The URL Trace tab content.
 *
 * URL input + optional headers textarea + Submit. Calls
 * POST /api/url-trace/flow on submit and renders the redirect chain
 * plus the final URL.
 *
 * Headers textarea format: one header per line, "Name: Value". Cookies
 * are just a `Cookie:` header. Lines starting with `#` are comments;
 * blank lines are ignored.
 *
 * State machine (signals):
 *   - idle:    no submit yet, just the input
 *   - loading: request in flight
 *   - error:   request returned non-2xx (or threw) — `errorMessage` set
 *   - success: response received — `result` set. Note that a success
 *              response can still carry a non-null `error` field on the
 *              body (e.g. when the chain hit the max-redirect cap or
 *              died mid-flight). Both are rendered in that case.
 */
@Component({
  selector: 'app-url-trace',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './url-trace.component.html',
  styleUrls: ['./url-trace.component.scss']
})
export class UrlTraceComponent {

  private readonly urlTrace = inject(UrlTraceService);

  // ── Form state ─────────────────────────────────────────────────

  protected readonly url = signal('');
  protected readonly headersText = signal('');
  protected readonly headersExpanded = signal(false);

  // ── Async state ────────────────────────────────────────────────

  protected readonly loading = signal(false);
  protected readonly result = signal<UrlTraceResponse | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  /** Per-line parse errors from the headers textarea. */
  protected readonly headerParseErrors = signal<string[]>([]);

  // ── Derived state ──────────────────────────────────────────────

  /** True when submit is allowed (not loading and input has content). */
  readonly canSubmit = computed(() => !this.loading() && this.url().trim().length > 0);

  /** True when the chain made more than one hop — drives the "redirected from" line. */
  readonly wasRedirected = computed(() => (this.result()?.totalHops ?? 0) > 1);

  /**
   * Number of headers parsed from the textarea (excluding blanks/comments).
   * Drives the section toggle label, e.g. "Headers (3)".
   */
  readonly parsedHeaderCount = computed(() => {
    const { headers } = parseHeaderBlob(this.headersText());
    return Object.keys(headers).length;
  });

  // ── Event handlers ─────────────────────────────────────────────

  submit(): void {
    const value = this.url().trim();
    if (!value || this.loading()) return;

    // Parse headers up front so we can surface format errors before the
    // request goes out.
    const { headers, errors } = parseHeaderBlob(this.headersText());
    if (errors.length > 0) {
      this.headerParseErrors.set(errors);
      return;
    }
    this.headerParseErrors.set([]);

    // Reset previous outcome so the UI doesn't show stale data while
    // the new request is in flight.
    this.errorMessage.set(null);
    this.result.set(null);
    this.loading.set(true);

    this.urlTrace.trace(value, headers).subscribe({
      next: (res) => {
        this.result.set(res);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.handleError(err);
        this.loading.set(false);
      }
    });
  }

  /** Submit on Ctrl/Cmd+Enter inside the headers textarea, plain Enter in the URL input. */
  onUrlKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.canSubmit()) {
      event.preventDefault();
      this.submit();
    }
  }

  onHeadersKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && this.canSubmit()) {
      event.preventDefault();
      this.submit();
    }
  }

  toggleHeaders(): void {
    this.headersExpanded.update(v => !v);
  }

  /** Clear results and inputs. */
  reset(): void {
    this.url.set('');
    this.headersText.set('');
    this.result.set(null);
    this.errorMessage.set(null);
    this.headerParseErrors.set([]);
  }

  // ── Error handling ─────────────────────────────────────────────

  private handleError(err: HttpErrorResponse): void {
    const body = err.error as UrlTraceError | undefined;
    if (body && typeof body === 'object' && typeof body.error === 'string') {
      this.errorMessage.set(body.error);
      return;
    }
    this.errorMessage.set(err.message || 'Request failed');
  }

  // ── Template helpers ───────────────────────────────────────────

  /**
   * CSS class hook for the status pill — green/amber/red bands matching
   * 2xx / 3xx / 4xx-5xx ranges.
   */
  statusClass(status: number): string {
    if (status >= 200 && status < 300) return 'status-pill--ok';
    if (status >= 300 && status < 400) return 'status-pill--redirect';
    return 'status-pill--err';
  }
}
