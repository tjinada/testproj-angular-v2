import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  Output,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import {
  AutomatedCheck,
  Release,
  Stage,
  SubStep,
  SubStepState,
} from '../../../../models/release-workflow.model';

/**
 * Stage 1 — Intake & Setup
 *
 * Two-column layout:
 *   - Left:  the 5 sub-steps. Auto-tickable items show their auto state and
 *            an Override link; explicit checkbox is hidden by default.
 *            Manual-only items show a checkbox directly.
 *   - Right: the 5 automated checks (Confluence x2, JIRA x2, GitHub).
 *
 * Actions:
 *   - "Run checks" button at top runs all stage checks server-side, which
 *     auto-ticks linked sub-steps when checks pass. The parent reloads the
 *     release after the call returns (via the (refresh) emitter).
 *   - Per sub-step: Override link reveals manual checkbox; N/A link toggles
 *     the n_a state. Both round-trip through the backend.
 */
@Component({
  selector: 'app-stage1-intake',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './stage1-intake.component.html',
  styleUrl: './stage1-intake.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Stage1IntakeComponent {
  @Input({ required: true }) stage!: Stage;
  @Input({ required: true }) release!: Release;

  /** Emitted whenever the parent should refetch the release (after any mutation). */
  @Output() refresh = new EventEmitter<void>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly running = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** Sub-step IDs whose Override row is currently expanded. */
  readonly overrideOpen = signal<Set<string>>(new Set());

  // ---------- run all checks ----------

  onRunChecks(): void {
    if (this.running()) return;
    this.running.set(true);
    this.error.set(null);

    this.api.runChecks(this.release.releaseId, this.stage.id).subscribe({
      next: () => {
        this.running.set(false);
        this.refresh.emit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to run checks');
        this.running.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  // ---------- sub-step actions ----------

  isAutoTickable(s: SubStep): boolean {
    return s.autoTickedBy.length > 0;
  }

  hasOverrideOpen(s: SubStep): boolean {
    return this.overrideOpen().has(s.id);
  }

  toggleOverride(s: SubStep): void {
    this.overrideOpen.update((set) => {
      const next = new Set(set);
      if (next.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      return next;
    });
  }

  /**
   * Manual override: toggle between unchecked and checked (with source: manual).
   * Used both for non-auto-tickable items and for Override rows.
   */
  toggleManual(s: SubStep): void {
    const nextState: SubStepState = s.state === 'checked' ? 'unchecked' : 'checked';
    this.updateSubStep(s, nextState, nextState === 'unchecked' ? null : 'manual');
  }

  /** N/A toggle. From any state, sets n_a; from n_a, returns to unchecked. */
  toggleNa(s: SubStep): void {
    const nextState: SubStepState = s.state === 'n_a' ? 'unchecked' : 'n_a';
    // n_a is a "completion" state but didn't come from a check, so source = manual.
    this.updateSubStep(s, nextState, nextState === 'unchecked' ? null : 'manual');
  }

  private updateSubStep(s: SubStep, state: SubStepState, source: SubStep['source']): void {
    this.error.set(null);
    this.api
      .updateSubStep(this.release.releaseId, this.stage.id, s.id, { state, source })
      .subscribe({
        next: () => {
          this.refresh.emit();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error.set(err?.error?.error ?? err?.message ?? 'Failed to update sub-step');
          this.cdr.detectChanges();
        },
      });
  }

  // ---------- presentational helpers ----------

  formatRelative(iso: string | null): string {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    const s = Math.round(ms / 1000);
    if (s < 60)    return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60)    return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24)    return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
  }

  /** Build a one-line summary string from the check's free-form result JSON. */
  resultSummary(c: AutomatedCheck): string {
    if (c.status === 'failed') return c.errorMessage ?? 'Failed';
    if (c.status === 'pending') return 'Not yet run';
    if (c.status === 'running') return 'Running…';
    if (!c.result) return c.status;

    // Per-check pretty-printers. Free to extend as more checks come online.
    if (c.id === 'check-confluence-page-resolves' || c.id === 'check-self-serve-link-resolves') {
      const title = (c.result as any).title;
      return title ? `Page found: ${title}` : 'Passed';
    }
    if (c.id === 'check-fix-version-exists') {
      const name = (c.result as any).name;
      return name ? `Fix Version: ${name}` : 'Passed';
    }
    if (c.id === 'check-env-matrix-pr') {
      const num = (c.result as any).prNumber;
      const state = (c.result as any).state;
      return num ? `PR #${num} (${state})` : 'Passed';
    }

    return 'Passed';
  }

  checkStatusClass(c: AutomatedCheck): string {
    return `check-card check-card--${c.status}`;
  }

  subStepStateLabel(s: SubStep): string {
    if (s.state === 'n_a')      return 'N/A';
    if (s.state === 'checked')  return s.source === 'auto' ? 'auto-checked' : 'checked';
    return 'unchecked';
  }
}
