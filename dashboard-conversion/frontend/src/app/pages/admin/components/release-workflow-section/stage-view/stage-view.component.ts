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
import { ReleaseWorkflowService } from '../../../services/release-workflow.service';
import {
  AutomatedCheck,
  Release,
  Stage,
  SubStep,
  SubStepState,
} from '../../../models/release-workflow.model';
import { formatCheckResult } from './check-result-display';

/**
 * Generic stage view. One component for all 10 stages.
 *
 * Layout:
 *   - Top action bar with stage metadata and "Run checks" button
 *     (button is hidden when the stage has no automated checks).
 *   - Two-column body:
 *     * Left:  sub-steps. Auto-tickable items show a status pill and an
 *              Override link; manual-only items show a checkbox.
 *     * Right: automated checks rail (omitted if the stage has none).
 *
 * Per-stage uniqueness is data-driven:
 *   - Sub-steps and checks come from the Stage object (seeded by the
 *     backend template).
 *   - Check result strings come from check-result-display.ts (sibling file,
 *     keyed by result shape so it doesn't grow per check).
 *   - Auto-tick links come from each sub-step's autoTickedBy array.
 *
 * If a stage genuinely needs a custom UI later, this generic view becomes
 * the default and a per-stage override component can be added back at the
 * release-detail switch site. For now: one component, all stages.
 */
@Component({
  selector: 'app-stage-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './stage-view.component.html',
  styleUrl: './stage-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StageViewComponent {
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

  hasChecks(): boolean {
    return this.stage.automatedChecks.length > 0;
  }

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

  toggleManual(s: SubStep): void {
    const nextState: SubStepState = s.state === 'checked' ? 'unchecked' : 'checked';
    this.updateSubStep(s, nextState, nextState === 'unchecked' ? null : 'manual');
  }

  toggleNa(s: SubStep): void {
    const nextState: SubStepState = s.state === 'n_a' ? 'unchecked' : 'n_a';
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

  resultSummary(c: AutomatedCheck): string {
    return formatCheckResult({
      status: c.status,
      result: c.result,
      errorMessage: c.errorMessage,
    });
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
