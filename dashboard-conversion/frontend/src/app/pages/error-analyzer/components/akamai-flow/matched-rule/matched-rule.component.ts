import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { AkamaiRuleEntry, MatchedRule } from '../../../models/akamai.model';

/**
 * Renders one matched rule as a collapsible card.
 *
 * Header: rule name, full ancestor path breadcrumb, match-status badge,
 * counts of criteria/behaviors.
 *
 * Expanded body (toggle by clicking the header):
 *   - Criteria section: each criterion's name + match-operator + values,
 *     with a "criteria must satisfy: ALL/ANY" label. Unevaluated criteria
 *     get a yellow tint.
 *   - Behaviors section: each behavior's name + a few key fields pulled
 *     from options (origin hostname, cache TTL, cpCode id), with a
 *     "show full options JSON" disclosure for the rest.
 *
 * Pure presentation. Owns nothing but its expand state. The parent
 * (akamai-flow.component) supplies the MatchedRule via input.
 */
@Component({
  selector: 'app-matched-rule',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './matched-rule.component.html',
  styleUrls: ['./matched-rule.component.scss']
})
export class MatchedRuleComponent {
  /** The rule to render. Required input. */
  rule = input.required<MatchedRule>();

  /**
   * Whether the parent wants this card opened by default. Useful so the
   * parent can auto-expand all rules, or just the first match, etc.
   * Defaults to false (collapsed).
   */
  initiallyExpanded = input<boolean>(false);

  /** Per-card expansion state. Toggled by clicking the header. */
  protected readonly expanded = signal(false);

  /** Per-behavior JSON disclosure state. Map from index → boolean. */
  protected readonly behaviorOptionsOpen = signal<Set<number>>(new Set());

  constructor() {
    // Honor initiallyExpanded once when the input first arrives.
    queueMicrotask(() => this.expanded.set(this.initiallyExpanded()));
  }

  // ── Derived state ───────────────────────────────────────────────

  /** Breadcrumb-style display of rulePath (excluding the leaf which is the title). */
  readonly ancestorPath = computed(() => {
    const path = this.rule().rulePath;
    if (path.length <= 1) return '';
    return path.slice(0, -1).join(' › ');
  });

  /** "ALL" or "ANY" for the criteriaMustSatisfy badge. */
  readonly mustSatisfyLabel = computed(() =>
    this.rule().criteriaMustSatisfy === 'any' ? 'ANY' : 'ALL'
  );

  /** True if the rule has no criteria (i.e. always-matches-when-reached). */
  readonly isUnconditional = computed(() => this.rule().criteria.length === 0);

  // ── Event handlers ──────────────────────────────────────────────

  toggleExpanded(): void {
    this.expanded.update(v => !v);
  }

  toggleBehaviorOptions(index: number): void {
    this.behaviorOptionsOpen.update(set => {
      const next = new Set(set);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // ── Template helpers ────────────────────────────────────────────

  isBehaviorOptionsOpen(index: number): boolean {
    return this.behaviorOptionsOpen().has(index);
  }

  isUnevaluated(criterionName: string): boolean {
    return this.rule().unevaluatedCriteria.includes(criterionName);
  }

  /**
   * Pulls a short "what does this criterion check" summary string.
   *
   * Examples:
   *   path MATCHES_ONE_OF /banking/messages/*, /banking/services/*
   *   hostname IS_ONE_OF www.example.com
   *   requestCookie cookieName="x-debug" value="failover" (UNEVALUATED)
   *
   * For unsupported criterion types, falls back to listing the option
   * keys present so the user can see what the criterion is trying to do.
   */
  criterionSummary(c: AkamaiRuleEntry): string {
    const opts = c.options || {};
    const op = typeof opts['matchOperator'] === 'string' ? opts['matchOperator'] : '';
    const values = Array.isArray(opts['values']) ? (opts['values'] as unknown[]).filter(v => typeof v === 'string') : [];

    // Path / hostname / fileExtension all use matchOperator + values.
    if (op && values.length > 0) {
      const valuesPreview = values.slice(0, 3).join(', ') + (values.length > 3 ? `, +${values.length - 3} more` : '');
      return `${c.name} ${op} ${valuesPreview}`;
    }

    // Fallback: list option keys for unsupported criterion types so the
    // user can at least see the shape of the rule.
    const keys = Object.keys(opts);
    if (keys.length > 0) {
      return `${c.name} (${keys.join(', ')})`;
    }
    return c.name;
  }

  /**
   * Pulls a short "what does this behavior do" summary for known
   * behavior types. Falls back to the behavior name only if we don't
   * have a special-case rendering for it.
   *
   * The JSON disclosure (toggleBehaviorOptions) shows the full options
   * for any behavior, so this is purely a glanceable hint.
   */
  behaviorSummary(b: AkamaiRuleEntry): string {
    const opts = b.options || {};
    switch (b.name) {
      case 'origin': {
        const host = typeof opts['hostname'] === 'string' ? opts['hostname'] : '';
        return host ? `origin → ${host}` : 'origin';
      }
      case 'cpCode': {
        const value = opts['value'] as Record<string, unknown> | undefined;
        const id = value && typeof value === 'object' ? value['id'] : undefined;
        return typeof id === 'number' ? `cpCode #${id}` : 'cpCode';
      }
      case 'caching': {
        const beh = typeof opts['behavior'] === 'string' ? opts['behavior'] : '';
        const ttl = typeof opts['ttl'] === 'string' ? opts['ttl'] : '';
        if (beh && ttl) return `caching: ${beh} (${ttl})`;
        if (beh) return `caching: ${beh}`;
        return 'caching';
      }
      case 'setVariable': {
        const name = typeof opts['variableName'] === 'string' ? opts['variableName'] : '';
        return name ? `setVariable ${name}` : 'setVariable';
      }
      default:
        return b.name;
    }
  }

  /** Pretty-prints an options object for the JSON disclosure. */
  formatOptions(opts: Record<string, unknown>): string {
    try {
      return JSON.stringify(opts, null, 2);
    } catch {
      return String(opts);
    }
  }
}
