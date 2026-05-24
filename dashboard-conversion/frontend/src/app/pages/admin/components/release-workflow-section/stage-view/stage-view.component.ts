import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReleaseWorkflowService } from '../../../services/release-workflow.service';
import {
  AutomatedCheck,
  Release,
  Stage,
  SubStep,
  SubStepState,
} from '../../../models/release-workflow.model';
import { AuthService } from '../../../../../../services/auth.service';
import { usernameFromEmail } from '../../../../../../utils/sheriff.util';
import { formatCheckResult } from './check-result-display';

/**
 * Stage pane — renders one stage's sub-step rows with integrated check status
 * and inline metadata editing.
 *
 * Each sub-step row carries:
 *   - Status indicator (passed / failed / running / unchecked / N/A)
 *   - Sub-step label
 *   - Linked check's result summary or error message inline
 *   - One of four interaction modes:
 *       (a) read-only display when the linked check is passing
 *       (b) input field when the linked check is failing or pending
 *       (c) running spinner while a save-and-run is in flight
 *       (d) plain checkbox when the sub-step has no editableField
 *
 * "Save & run" persists the field via PATCH /metadata, which the backend
 * handles atomically — it saves, then re-runs the affected stages' checks,
 * then returns the updated release. We mark the row as running, fire the
 * patch, and refetch on completion.
 *
 * Override is always available regardless of check state — it directly
 * mutates the sub-step's state via PUT /sub-steps. Manual ticks are sticky
 * against subsequent auto-tick reconciliation.
 */
@Component({
  selector: 'app-stage-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './stage-view.component.html',
  styleUrl: './stage-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StageViewComponent implements OnChanges {
  @Input({ required: true }) stage!: Stage;
  @Input({ required: true }) release!: Release;
  @Input() showHeader = true;
  @Input() focusSubStepId: string | null = null;

  @Output() refresh = new EventEmitter<void>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly auth = inject(AuthService);
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * Username of the current logged-in user, derived from AuthService.currentUser.
   * Used as the `actor` on every manual sub-step mutation so the backend records
   * who performed the action (rather than the 'unknown' fallback).
   *
   * Returns null when no user is loaded yet — the backend writes 'unknown' in
   * that case, which is the same behaviour as before this method existed.
   */
  private currentActor(): string | null {
    const email = this.auth.currentUser()?.email;
    return email ? usernameFromEmail(email) : null;
  }

  /** Sub-step IDs whose row is in edit mode (input visible, populated with current value). */
  readonly editingIds = signal<Set<string>>(new Set());

  /** Sub-step IDs whose row is currently running (spinner shown, actions disabled). */
  readonly runningIds = signal<Set<string>>(new Set());

  /**
   * Sub-step IDs that were just saved successfully but whose release refetch
   * hasn't yet arrived. Used to suppress the auto-show-input logic in
   * showInput() during the transient window between save-success and the
   * fresh release data arriving. Cleared on the next ngOnChanges (which
   * fires when the parent re-emits release after load() completes).
   *
   * Without this, the row briefly re-opens its input field between the
   * save response and the load response because showInput sees the OLD
   * check.status (still 'failed' or 'pending') and falls into the
   * "show input for unsatisfied checks" branch.
   */
  readonly justSavedIds = signal<Set<string>>(new Set());

  /** Per-row staged input value, keyed by sub-step ID. Cleared on submit/cancel. */
  readonly inputValues = signal<Record<string, string>>({});

  readonly error = signal<string | null>(null);

  readonly highlightedSubStepId = signal<string | null>(null);

  private lastAppliedFocusKey: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    // Clear "just-saved" suppression marks only when the release input itself
    // changes — that's the moment fresh release data has arrived and showInput
    // can rely on the new check.status. Clearing on every ngOnChanges (e.g.
    // when only focusSubStepId changed) would prematurely drop the suppression
    // before the release refetch landed, causing the row's input to re-appear
    // briefly between save-response and load-response.
    if (changes['release'] && this.justSavedIds().size > 0) {
      this.justSavedIds.set(new Set());
    }
    this.applyFocusRequest();
  }

  private applyFocusRequest(): void {
    // When the parent clears focusSubStepId (e.g. after a successful save),
    // also drop the row highlight so it returns to a quiet state.
    if (!this.focusSubStepId) {
      this.highlightedSubStepId.set(null);
      this.lastAppliedFocusKey = null;
      return;
    }
    const focusKey = `${this.stage.id}:${this.focusSubStepId}`;
    if (focusKey === this.lastAppliedFocusKey) return;

    const target = this.stage.subSteps.find((s) => s.id === this.focusSubStepId);
    if (!target) return;

    this.lastAppliedFocusKey = focusKey;
    this.highlightedSubStepId.set(target.id);

    if (target.editableField) {
      this.beginEdit(target);
    }
  }

  // ----- linked check resolution -----

  /**
   * The check linked to a sub-step (the first one in autoTickedBy that exists
   * on the stage, since today every auto-tickable sub-step has exactly one
   * linked check). Returns null for manual-only sub-steps.
   */
  linkedCheck(s: SubStep): AutomatedCheck | null {
    if (!s.autoTickedBy || s.autoTickedBy.length === 0) return null;
    return this.stage.automatedChecks.find((c) => s.autoTickedBy.includes(c.id)) ?? null;
  }

  // ----- row state classification -----

  isAutoTickable(s: SubStep): boolean {
    return s.autoTickedBy.length > 0;
  }

  hasEditableField(s: SubStep): boolean {
    return !!s.editableField;
  }

  isRunning(s: SubStep): boolean {
    return this.runningIds().has(s.id);
  }

  isEditing(s: SubStep): boolean {
    return this.editingIds().has(s.id);
  }

  /**
   * True if the row should display the input field. Either the sheriff
   * explicitly opened it via "Edit", or the linked check is failing/pending
   * and there's no value yet to show in read-only form.
   */
  showInput(s: SubStep): boolean {
    if (!this.hasEditableField(s)) return false;
    if (this.isRunning(s)) return false;
    // Suppress the auto-show-input branch while we're waiting for the fresh
    // release data after a successful save. Without this, the row briefly
    // re-opens its input because check.status is still stale (failed/pending)
    // for the moment between save-response and load-response. Cleared on the
    // next ngOnChanges (= release Input updated).
    if (this.justSavedIds().has(s.id)) return false;
    if (this.isEditing(s)) return true;
    const check = this.linkedCheck(s);
    if (!check) return false;
    return check.status === 'failed' || check.status === 'pending';
  }

  // ----- value display -----

  /** The current persisted value of the sub-step's editable field. */
  fieldValue(s: SubStep): string | null {
    if (!s.editableField) return null;
    if (s.editableField.startsWith('branches.')) {
      const key = s.editableField.slice('branches.'.length) as keyof Release['metadata']['branches'];
      return this.release.metadata.branches?.[key] ?? null;
    }
    return (this.release.metadata as any)[s.editableField] ?? null;
  }

  /** Pretty result string from the linked check (passing or failing). */
  resultLine(s: SubStep): string {
    const check = this.linkedCheck(s);
    if (!check) return '';
    return formatCheckResult({
      status: check.status,
      result: check.result,
      errorMessage: check.errorMessage,
    });
  }

  /**
   * True when the linked check's result is the multi-URL shape — i.e. the
   * runner is githubBranchUrlsMultiCheck. Detected by shape: result has
   * a numeric `total` and an array of `branches` and/or `failures` with
   * per-URL entries. The template uses this to render a per-URL list
   * instead of a single summary line.
   */
  isMultiUrlResult(s: SubStep): boolean {
    const check = this.linkedCheck(s);
    if (!check || !check.result) return false;
    const r = check.result as any;
    return typeof r.total === 'number' && (Array.isArray(r.branches) || Array.isArray(r.failures));
  }

  /**
   * Combined per-URL entries from the multi-URL result, in input order:
   * each entry is { url, ok, label, reason? }.
   *   - ok=true  → label is "branchName" (or url fallback), no reason
   *   - ok=false → label is url, reason is the failure detail
   * Returns [] for any non-multi-URL check.
   */
  multiUrlEntries(s: SubStep): Array<{ url: string; ok: boolean; label: string; reason: string | null }> {
    const check = this.linkedCheck(s);
    if (!check || !check.result) return [];
    const r = check.result as any;
    const branches = Array.isArray(r.branches) ? r.branches : [];
    const failures = Array.isArray(r.failures) ? r.failures : [];
    return [
      ...branches.map((b: any) => ({
        url: String(b.url ?? ''),
        ok: true,
        label: String(b.branchName ?? b.url ?? ''),
        reason: null,
      })),
      ...failures.map((f: any) => ({
        url: String(f.url ?? ''),
        ok: false,
        label: String(f.url ?? ''),
        reason: String(f.reason ?? 'failed'),
      })),
    ];
  }

  // ----- input value -----

  inputValue(s: SubStep): string {
    return this.inputValues()[s.id] ?? this.fieldValue(s) ?? '';
  }

  onInputChange(s: SubStep, val: string): void {
    this.inputValues.update((v) => ({ ...v, [s.id]: val }));
  }

  // ----- actions: edit, save, cancel -----

  beginEdit(s: SubStep): void {
    if (!s.editableField) return;
    this.editingIds.update((set) => {
      const next = new Set(set);
      next.add(s.id);
      return next;
    });
    // Pre-populate the input with the current persisted value.
    this.inputValues.update((v) => ({ ...v, [s.id]: this.fieldValue(s) ?? '' }));
  }

  cancelEdit(s: SubStep): void {
    this.editingIds.update((set) => {
      const next = new Set(set);
      next.delete(s.id);
      return next;
    });
    this.inputValues.update((v) => {
      const next = { ...v };
      delete next[s.id];
      return next;
    });
  }

  saveAndRun(s: SubStep): void {
    if (!s.editableField) return;
    const newValue = (this.inputValues()[s.id] ?? '').trim();

    this.error.set(null);
    this.runningIds.update((set) => {
      const next = new Set(set);
      next.add(s.id);
      return next;
    });
    // Close the editor optimistically — the row enters the running state.
    this.editingIds.update((set) => {
      const next = new Set(set);
      next.delete(s.id);
      return next;
    });

    const patch: Record<string, string | null> = {
      [s.editableField]: newValue || null,
    };

    // Send the actor so the backend credits the human who pasted the URL
    // when the linked check passes and auto-ticks the sub-step. Bulk re-runs
    // ("Run all checks") do NOT send an actor — those are re-verifications
    // of existing values, not authorship of a new completion.
    const actor = this.currentActor() ?? undefined;

    this.api.updateMetadata(this.release.releaseId, patch, actor).subscribe({
      next: () => {
        this.runningIds.update((set) => {
          const next = new Set(set);
          next.delete(s.id);
          return next;
        });
        this.inputValues.update((v) => {
          const next = { ...v };
          delete next[s.id];
          return next;
        });
        // Mark this sub-step as "just saved" so showInput suppresses the
        // auto-show branch until fresh release data lands (next ngOnChanges).
        this.justSavedIds.update((set) => {
          const next = new Set(set);
          next.add(s.id);
          return next;
        });
        this.refresh.emit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.runningIds.update((set) => {
          const next = new Set(set);
          next.delete(s.id);
          return next;
        });
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to save and run check');
        this.cdr.detectChanges();
      },
    });
  }

  // ----- actions: override, N/A, manual checkbox -----

  /**
   * Flip the sub-step's tick state with a manual source.
   * - Currently checked? Un-check (manually).
   * - Currently unchecked or N/A? Check (manually).
   *
   * Manual override is sticky against subsequent auto-tick runs.
   */
  override(s: SubStep): void {
    const nextState: SubStepState = s.state === 'checked' ? 'unchecked' : 'checked';
    this.updateSubStep(s, nextState, nextState === 'unchecked' ? null : 'manual');
  }

  /** Toggle N/A on/off. Going off-N/A returns the sub-step to unchecked. */
  toggleNa(s: SubStep): void {
    const nextState: SubStepState = s.state === 'n_a' ? 'unchecked' : 'n_a';
    this.updateSubStep(s, nextState, nextState === 'unchecked' ? null : 'manual');
  }

  /** Plain manual checkbox toggle for sub-steps with no editableField. */
  toggleManualCheckbox(s: SubStep): void {
    const nextState: SubStepState = s.state === 'checked' ? 'unchecked' : 'checked';
    this.updateSubStep(s, nextState, nextState === 'unchecked' ? null : 'manual');
  }

  private updateSubStep(s: SubStep, state: SubStepState, source: SubStep['source']): void {
    this.error.set(null);
    const actor = this.currentActor() ?? undefined;
    this.api
      .updateSubStep(this.release.releaseId, this.stage.id, s.id, { state, source, actor })
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

  // ----- presentational helpers -----

  /** Status indicator class for the row's left dot. */
  rowStatus(s: SubStep): 'passed' | 'failed' | 'running' | 'pending' | 'na' {
    if (this.isRunning(s)) return 'running';
    if (s.state === 'n_a') return 'na';
    if (s.state === 'checked') return 'passed';
    if (this.isAutoTickable(s)) {
      const c = this.linkedCheck(s);
      if (c?.status === 'failed') return 'failed';
    }
    return 'pending';
  }

  /** CSS class for the row's container. */
  rowClass(s: SubStep): string {
    const status = this.rowStatus(s);
    const parts = [`ss-row`, `ss-row--${status}`];
    if (this.highlightedSubStepId() === s.id) parts.push('ss-row--highlight');
    return parts.join(' ');
  }

  /** Subtitle line under the sub-step label. e.g. "auto-checked · system · 5/7/26". */
  subTitle(s: SubStep): string {
    if (s.state === 'n_a') return 'N/A';
    if (s.state === 'checked') {
      const who = s.completedBy ?? 'unknown';
      const when = s.completedAt ? new Date(s.completedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `${s.source === 'manual' ? 'manually checked' : 'auto-checked'}${when ? ' · ' + who + ' · ' + when : ''}`;
    }
    return 'unchecked';
  }

  /**
   * Compact label for the right-column timestamp on completed rows.
   * Shows the actor when it's a real user ("manually checked · tj · May 13",
   * "auto-checked · tj · May 13"). Drops the actor when it's 'system' or
   * 'unknown' — noise that adds no audit value ("auto-checked · May 13").
   * Returns null when the row isn't in a checked state so the line is hidden
   * entirely on pending rows.
   */
  completedAtLabel(s: SubStep): string | null {
    if (s.state !== 'checked' || !s.completedAt) return null;
    const date = new Date(s.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const verb = s.source === 'manual' ? 'manually checked' : 'auto-checked';
    const actor = s.completedBy;
    const showActor = actor && actor !== 'system' && actor !== 'unknown';
    return showActor
      ? `${verb} · ${actor} · ${date}`
      : `${verb} · ${date}`;
  }

  /**
   * Placeholder text for the inline input. The persisted `placeholder` was
   * resolved at boot time by the loader — either from the runner's default
   * placeholder table or from an explicit `placeholder:` in YAML. We just
   * read it here, with a generic fallback for unusual cases.
   */
  inputPlaceholder(s: SubStep): string {
    return s.placeholder ?? 'Paste value';
  }

  // ----- run-all-checks button -----

  hasChecks(): boolean {
    return this.stage.automatedChecks.length > 0;
  }

  readonly runningAll = signal<boolean>(false);

  runAllChecks(): void {
    if (this.runningAll()) return;
    this.runningAll.set(true);
    this.error.set(null);
    this.api.runChecks(this.release.releaseId, this.stage.id).subscribe({
      next: () => {
        this.runningAll.set(false);
        this.refresh.emit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.runningAll.set(false);
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to run checks');
        this.cdr.detectChanges();
      },
    });
  }
}
