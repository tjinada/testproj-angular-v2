import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AkamaiService } from '../../services/akamai.service';
import {
  isHostnameError,
  type AkamaiBaseline,
  type AkamaiFlowError,
  type AkamaiFlowResult
} from '../../models/akamai.model';
import { MatchedRuleComponent } from './matched-rule/matched-rule.component';

/**
 * The Akamai Flow tab content.
 *
 * Single URL input + Submit. Calls POST /api/akamai/flow on submit,
 * renders the structured result: resolution summary, baseline card,
 * matcher disclaimer, and the matched-rule list.
 *
 * State machine (signals):
 *   - idle:    no submit yet, just the input
 *   - loading: request in flight
 *   - error:   request returned non-2xx (or threw)
 *   - success: request returned 2xx, results visible
 *
 * The component owns no derived URL state — it just submits whatever
 * the input contains. The backend does parsing, hostname resolution,
 * and matching.
 */
@Component({
  selector: 'app-akamai-flow',
  standalone: true,
  imports: [CommonModule, FormsModule, MatchedRuleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './akamai-flow.component.html',
  styleUrls: ['./akamai-flow.component.scss']
})
export class AkamaiFlowComponent {

  private readonly akamai = inject(AkamaiService);

  // ── Form state ─────────────────────────────────────────────────

  protected readonly url = signal('');

  // ── Async state ────────────────────────────────────────────────

  protected readonly loading = signal(false);
  protected readonly result = signal<AkamaiFlowResult | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  /**
   * 404-shaped error payload, set when the hostname isn't configured.
   * Populated alongside errorMessage so the template can render the
   * "configured hostnames include..." hint when present.
   */
  protected readonly hostnameErrorBody = signal<{
    configuredHostnameCount: number;
    configuredHostnamesSample: string[];
  } | null>(null);

  // ── Derived state ──────────────────────────────────────────────

  /** True when submit is allowed (not currently loading and the input has content). */
  readonly canSubmit = computed(() => !this.loading() && this.url().trim().length > 0);

  /** Convenience accessor used in the template; null when no result. */
  readonly baseline = computed<AkamaiBaseline | null>(() => this.result()?.baseline ?? null);

  // ── Event handlers ─────────────────────────────────────────────

  submit(): void {
    const value = this.url().trim();
    if (!value || this.loading()) return;

    // Reset previous outcome so the UI doesn't show stale data while
    // the new request is in flight.
    this.errorMessage.set(null);
    this.hostnameErrorBody.set(null);
    this.result.set(null);
    this.loading.set(true);

    this.akamai.resolveFlow(value).subscribe({
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

  /** Submit on Enter inside the URL input. */
  onUrlKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.canSubmit()) {
      event.preventDefault();
      this.submit();
    }
  }

  /** Clear results and input (the small "×" affordance in the header). */
  reset(): void {
    this.url.set('');
    this.result.set(null);
    this.errorMessage.set(null);
    this.hostnameErrorBody.set(null);
  }

  // ── Error handling ─────────────────────────────────────────────

  private handleError(err: HttpErrorResponse): void {
    // err.error is the parsed JSON body the backend sent (Express
    // sends application/json on all error responses, so Angular's
    // HttpClient gives us an object here, not a string).
    const body = err.error as AkamaiFlowError | undefined;

    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      this.errorMessage.set(body.error);

      // 404 with hostname details: surface configured-hostnames hint.
      if (err.status === 404 && isHostnameError(body)) {
        this.hostnameErrorBody.set({
          configuredHostnameCount: body.configuredHostnameCount,
          configuredHostnamesSample: body.configuredHostnamesSample
        });
      }
      return;
    }

    // Fallback for unexpected error shapes (network errors, proxy-served
    // HTML, etc.). HttpErrorResponse.message is generally a useful one-liner.
    this.errorMessage.set(err.message || 'Request failed');
  }

  // ── Template helpers ───────────────────────────────────────────

  /** Friendly "—" when a baseline field is missing. Keeps the UI scannable. */
  display(value: string | number | undefined): string {
    if (value === undefined || value === null || value === '') return '—';
    return String(value);
  }
}
