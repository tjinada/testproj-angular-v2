import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AkamaiService } from '../../services/akamai.service';
import {
  isHostnameError,
  type AkamaiFlowError,
  type AkamaiFlowResult,
  type AkamaiRuleEntry,
  type CategorizedMatchedRule
} from '../../models/akamai.model';

/**
 * Simplified Akamai Flow tab.
 *
 * Single URL input + Submit. Calls POST /api/akamai/flow on submit.
 * Renders only the rewrite-style behaviors found across matched rules,
 * in rule-order — nothing about origin, caching, cpCode, or rule
 * categorization. Intent: answer "what path does Akamai rewrite this
 * URL to?" and nothing else.
 *
 * The richer original UI (resolution banner, baseline section, rule
 * categorization) was removed at the user's request. The matched-rule
 * sub-component is no longer used by this tab.
 */

/** Behavior names treated as "rewrite-style" — i.e. they change the URL/path. */
const REWRITE_BEHAVIOR_NAMES = new Set<string>([
  'rewriteUrl',
  'redirect',
  'redirectplus',
  'forwardRewrite'
]);

/** One row in the rewrites list. Pre-flattened for the template. */
interface RewriteRow {
  /** The behavior name (e.g. 'rewriteUrl', 'redirect'). */
  behaviorName: string;
  /** Best-effort extraction of the target path/URL from `options`. */
  target: string | null;
  /** Best-effort extraction of the rewrite mode (e.g. 'REWRITE', 'PREPEND'). */
  mode: string | null;
  /** All options as-is, for display under a "details" disclosure. */
  options: Record<string, unknown>;
  /** Rule path from root, e.g. ['default', 'CDB - APIC', 'CDB- Gatekeeper qa56']. */
  rulePath: string[];
}

@Component({
  selector: 'app-akamai-flow',
  standalone: true,
  imports: [CommonModule, FormsModule],
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

  /**
   * Flat list of rewrite-style behaviors across all matched rules, in
   * rule-evaluation order (matchedRules is already in that order). Each
   * row carries its source rule's path so the user can see which rule
   * fired the rewrite.
   */
  readonly rewrites = computed<RewriteRow[]>(() => {
    const rules = this.result()?.matchedRules ?? [];
    const rows: RewriteRow[] = [];

    for (const rule of rules) {
      for (const behavior of rule.behaviors) {
        if (!REWRITE_BEHAVIOR_NAMES.has(behavior.name)) continue;
        rows.push(this.toRewriteRow(behavior, rule));
      }
    }

    return rows;
  });

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

  /** Clear results and input. */
  reset(): void {
    this.url.set('');
    this.result.set(null);
    this.errorMessage.set(null);
    this.hostnameErrorBody.set(null);
  }

  // ── Error handling ─────────────────────────────────────────────

  private handleError(err: HttpErrorResponse): void {
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

    this.errorMessage.set(err.message || 'Request failed');
  }

  // ── Rewrite extraction ─────────────────────────────────────────

  /**
   * Pulls target + mode from a behavior's options. Different behavior
   * names use different option keys, so we check the common ones:
   *   - rewriteUrl      → options.targetUrl, options.behavior (REWRITE / PREPEND / REPLACE)
   *   - redirect        → options.destinationPath, options.responseCode
   *   - redirectplus    → options.destination
   *   - forwardRewrite  → options.targetUrl
   *
   * Anything we can't find is shown as "—" and the raw options JSON is
   * available below the row for the user to inspect.
   */
  private toRewriteRow(behavior: AkamaiRuleEntry, rule: CategorizedMatchedRule): RewriteRow {
    const opts = behavior.options || {};
    const pickString = (key: string): string | null => {
      const v = opts[key];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };

    const target =
      pickString('targetUrl') ??
      pickString('destinationPath') ??
      pickString('destination') ??
      pickString('targetPath');

    const mode = pickString('behavior'); // e.g. 'REWRITE', 'PREPEND', 'REPLACE'

    return {
      behaviorName: behavior.name,
      target,
      mode,
      options: opts,
      rulePath: rule.rulePath
    };
  }

  // ── Template helpers ───────────────────────────────────────────

  /** Joins a rule path for compact display (e.g. "default › X › Y"). */
  formatRulePath(path: string[]): string {
    return path.join(' › ');
  }

  /** Pretty-prints options for the details disclosure. */
  formatOptions(options: Record<string, unknown>): string {
    try {
      return JSON.stringify(options, null, 2);
    } catch {
      return String(options);
    }
  }
}
