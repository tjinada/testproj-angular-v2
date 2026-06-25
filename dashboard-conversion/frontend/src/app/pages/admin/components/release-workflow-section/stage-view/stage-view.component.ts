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
import { ReleaseWorkflowService } from '../../../../../services/release-workflow.service';
import { AuthService } from '../../../../../services/auth.service';
import { usernameFromEmail } from '../../../../../utils/sheriff.util';
import {
  AutomatedCheck,
  Release,
  Stage,
  StageStatus,
  SubStep,
  SubStepState,
  SubStepTrack,
} from '../../../../../models/release-workflow.model';
import { formatCheckResult } from './check-result-display';
import { visibleSubStepsForRelease } from '../../../../../utils/release-components.util';
import { DaTeamEmailsComponent } from '../components/da-team-emails/da-team-emails.component';

type StageDraftState = {
  editingIds: string[];
  inputValues: Record<string, string>;
  fieldErrors: Record<string, string>;
};

const stageDraftCache = new Map<string, StageDraftState>();

/**
 * Stage pane — renders one stage's sub-step rows with integrated check status
 */
@Component({
  selector: 'app-stage-view',
  standalone: true,
  imports: [CommonModule, FormsModule, DaTeamEmailsComponent],
  templateUrl: './stage-view.component.html',
  styleUrl: './stage-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StageViewComponent implements OnChanges {
  private readonly earlyRetrofitReleaseStageId = 'stage3-early-retrofit-release';

  @Input({ required: true }) stage!: Stage;
  @Input({ required: true }) release!: Release;
  @Input() showHeader = true;
  @Input() focusSubStepId: string | null = null;

  @Output() refresh = new EventEmitter<void>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly auth = inject(AuthService);

  private currentActor(): string | null {
    const email = this.auth.currentUser()?.email;
    return email ? usernameFromEmail(email) : null;
  }

  /** Sub-step IDs whose row is in edit mode (input visible, populated with current value). */
  readonly editingIds = signal<Set<string>>(new Set());

  /** Sub-step IDs whose row is currently running (spinner shown, actions disabled). */
  readonly runningIds = signal<Set<string>>(new Set());
  readonly stageNaPending = signal<boolean>(false);

   readonly justSavedIds = signal<Set<string>>(new Set());

  /** Per-row staged input value, keyed by sub-step ID. Cleared on submit/cancel. */
  readonly inputValues = signal<Record<string, string>>({});

  readonly stageError = signal<string | null>(null);
  readonly fieldErrors = signal<Record<string, string>>({});
  readonly highlightedSubStepId = signal<string | null>(null);

  private lastAppliedFocusKey: string | null = null;

  private stageDraftKey(): string | null {
    const releaseId = this.release?.releaseId;
    const stageId = this.stage?.id;
    return releaseId && stageId ? `${releaseId}:${stageId}` : null;
  }

  private restoreDraftState(): void {
    const key = this.stageDraftKey();
    if (!key) return;
    const draft = stageDraftCache.get(key);
    if (!draft) return;
    this.editingIds.set(new Set(draft.editingIds));
    this.inputValues.set({ ...draft.inputValues });
    this.fieldErrors.set({ ...draft.fieldErrors });
  }

  private persistDraftState(): void {
    const key = this.stageDraftKey();
    if (!key) return;

    const stageSubStepIds = new Set(this.stage.subSteps.map((subStep) => subStep.id));
    const editingIds = [...this.editingIds()].filter((id) => stageSubStepIds.has(id));
    const inputValues = Object.fromEntries(
      Object.entries(this.inputValues()).filter(([id]) => stageSubStepIds.has(id)),
    );
    const fieldErrors = Object.fromEntries(
      Object.entries(this.fieldErrors()).filter(([id]) => stageSubStepIds.has(id)),
    );

    if (editingIds.length === 0 && Object.keys(inputValues).length === 0 && Object.keys(fieldErrors).length === 0) {
      stageDraftCache.delete(key);
      return;
    }

    stageDraftCache.set(key, {
      editingIds,
      inputValues,
      fieldErrors,
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['release'] && this.justSavedIds().size > 0) {
      this.justSavedIds.set(new Set());
    }
    if (changes['release']) {
      this.fieldErrors.set({});
    }
    if (changes['stage'] || changes['release']) {
      this.restoreDraftState();
    }
    this.applyFocusRequest();
  }

  fieldError(s: SubStep): string | null {
    return this.fieldErrors()[s.id] ?? null;
  }

  hasFieldError(s: SubStep): boolean {
    return !!this.fieldErrors()[s.id];
  }

  private clearFieldError(subStepId: string): void {
    this.fieldErrors.update((errors) => {
      if (!(subStepId in errors)) return errors;
      const next = { ...errors };
      delete next[subStepId];
      return next;
    });
  }

  private setFieldError(subStepId: string, message: string): void {
    this.fieldErrors.update((errors) => ({ ...errors, [subStepId]: message }));
  }

  private applyFocusRequest(): void {
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

  showInput(s: SubStep): boolean {
    if (!this.hasEditableField(s)) return false;
    if (this.isRunning(s)) return false;
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

  isMultiUrlResult(s: SubStep): boolean {
    const check = this.linkedCheck(s);
    if (!check || !check.result) return false;
    const r = check.result as any;
    return typeof r.total === 'number' && (Array.isArray(r.branches) || Array.isArray(r.failures));
  }

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

  canSaveAndRun(s: SubStep): boolean {
    if (!s.editableField || this.isRunning(s)) return false;

    const currentValue = this.inputValue(s).trim();
    const persistedValue = (this.fieldValue(s) ?? '').trim();
    if (currentValue === persistedValue) return false;
    return true;
  }

  onInputChange(s: SubStep, val: string): void {
    this.inputValues.update((v) => ({ ...v, [s.id]: val }));
    this.persistDraftState();
  }

  // ----- actions: edit, save, cancel -----

  beginEdit(s: SubStep): void {
    if (!s.editableField) return;
    this.clearFieldError(s.id);
    this.editingIds.update((set) => {
      const next = new Set(set);
      next.add(s.id);
      return next;
    });
    // Pre-populate the input with the current persisted value.
    this.inputValues.update((v) => ({ ...v, [s.id]: this.fieldValue(s) ?? '' }));
    this.persistDraftState();
  }

  cancelEdit(s: SubStep): void {
    this.clearFieldError(s.id);
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
    this.persistDraftState();
  }

  saveAndRun(s: SubStep): void {
    const editableField = s.editableField;
    if (!editableField || !this.canSaveAndRun(s)) return;
    const newValue = this.inputValue(s).trim();

    this.stageError.set(null);
    this.clearFieldError(s.id);
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
      [editableField]: newValue || null,
    };

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
        this.justSavedIds.update((set) => {
          const next = new Set(set);
          next.add(s.id);
          return next;
        });
        this.clearFieldError(s.id);
        this.persistDraftState();
        this.refresh.emit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.runningIds.update((set) => {
          const next = new Set(set);
          next.delete(s.id);
          return next;
        });
        this.editingIds.update((set) => {
          const next = new Set(set);
          next.add(s.id);
          return next;
        });
        this.setFieldError(s.id, err?.error?.error ?? err?.message ?? 'Failed to save and run check');
        this.persistDraftState();
        this.cdr.detectChanges();
      },
    });
  }

  // ----- actions: override, N/A, manual checkbox -----

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
    this.stageError.set(null);
    const actor = this.currentActor() ?? undefined;
    this.api
      .updateSubStep(this.release.releaseId, this.stage.id, s.id, { state, source, actor })
      .subscribe({
        next: () => {
          this.refresh.emit();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.stageError.set(err?.error?.error ?? err?.message ?? 'Failed to update sub-step');
          this.cdr.detectChanges();
        },
      });
  }

  /** Status indicator class for the row's left dot. */
  rowStatus(s: SubStep): 'passed' | 'failed' | 'running' | 'pending' | 'na' {
    if (this.isRunning(s)) return 'running';
    if (this.hasFieldError(s)) return 'failed';
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

  inputPlaceholder(s: SubStep): string {
    return s.placeholder ?? 'Paste value';
  }

  // ----- run-all-checks button -----

  hasChecks(): boolean {
    return this.visibleAutomatedCheckCount() > 0;
  }

  hasVisibleSubSteps(): boolean {
    return this.visibleSubSteps().length > 0;
  }

  allVisibleSubStepsNa(): boolean {
    const subSteps = this.visibleSubSteps();
    return subSteps.length > 0 && subSteps.every((subStep) => subStep.state === 'n_a');
  }

  stageStatusLabel(): string {
    switch (this.stage.status) {
      case 'locked':
        return 'locked';
      case 'ready':
        return 'ready';
      case 'in_progress':
        return 'in progress';
      case 'complete':
        return 'complete';
      case 'skipped':
        return 'skipped';
      default:
        return this.stage.status satisfies StageStatus;
    }
  }

  stageStatusClass(): string {
    return `sp__status sp__status--${this.stage.status.replace('_', '-')}`;
  }

  canShowStageNaAction(): boolean {
    if (this.stage.status === 'complete') return false;
    return this.release.type !== 'bundle' || this.stage.id === this.earlyRetrofitReleaseStageId;
  }

  canExcludeSubSteps(): boolean {
    return this.release.type !== 'bundle' || this.stage.id === this.earlyRetrofitReleaseStageId;
  }

  private resetTransientRowState(): void {
    this.editingIds.set(new Set());
    this.runningIds.set(new Set());
    this.justSavedIds.set(new Set());
    this.inputValues.set({});
    this.fieldErrors.set({});
    this.highlightedSubStepId.set(null);
    this.lastAppliedFocusKey = null;
    this.persistDraftState();
  }

  toggleStageNa(): void {
    if (this.stageNaPending() || !this.hasVisibleSubSteps() || !this.canShowStageNaAction()) return;

    this.stageNaPending.set(true);
    this.stageError.set(null);
    const actor = this.currentActor() ?? undefined;
    const nextNa = !this.allVisibleSubStepsNa();

    this.api.updateStageNa(this.release.releaseId, this.stage.id, { na: nextNa, actor }).subscribe({
      next: () => {
        this.resetTransientRowState();
        this.stageNaPending.set(false);
        this.refresh.emit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.stageNaPending.set(false);
        this.stageError.set(err?.error?.error ?? err?.message ?? 'Failed to update stage');
        this.cdr.detectChanges();
      },
    });
  }

  visibleSubSteps(): SubStep[] {
    return visibleSubStepsForRelease(this.stage, this.release);
  }

  visibleAutomatedCheckCount(): number {
    return new Set(this.visibleSubSteps().flatMap((subStep) => subStep.autoTickedBy)).size;
  }

  presentTracks(): SubStepTrack[] {
    const seen = new Set<SubStepTrack>();
    for (const s of this.visibleSubSteps()) seen.add(this.trackOf(s));
    return (['generic', 'cdbui', 'cdbbos'] as const).filter((t) => seen.has(t));
  }

  /** Sub-steps belonging to a given track, in their original stage order. */
  subStepsForTrack(track: SubStepTrack): SubStep[] {
    return this.visibleSubSteps().filter((s) => this.trackOf(s) === track);
  }

  private trackOf(s: SubStep): SubStepTrack {
    const t = s.track;
    return t === 'cdbui' || t === 'cdbbos' ? t : 'generic';
  }

  /** Human-readable header label for a track. */
  trackLabel(track: SubStepTrack): string {
    switch (track) {
      case 'generic': return 'General';
      case 'cdbui':   return 'CDB UI';
      case 'cdbbos':  return 'CDBBOS';
    }
  }


  readonly runningAll = signal<boolean>(false);

  readonly creatingUi = signal<boolean>(false);
  readonly creatingBos = signal<boolean>(false);

  createMaster(type: 'ui' | 'bos'): void {
    if (!this.release?.releaseId) return;
    const isUi = type === 'ui';
    if ((isUi && this.creatingUi()) || (!isUi && this.creatingBos())) return;

    const user = this.auth.currentUser();
    const requestor = { name: user ? usernameFromEmail(user.email) : '', email: user?.email ?? '' };

    if (isUi) this.creatingUi.set(true); else this.creatingBos.set(true);

    this.api.createConfigJiras(this.release.releaseId, requestor, type).subscribe({
      next: (res) => {
        if (isUi) this.creatingUi.set(false); else this.creatingBos.set(false);
        this.refresh.emit();
        // show basic feedback
        try {
          if (res.subtaskErrors && res.subtaskErrors.length > 0) {
            alert(`Master config ticket created. Some subtasks failed:\n${res.subtaskErrors.join('\n')}`);
          } else {
            alert('Master config ticket created.');
          }
        } catch (e) {
          /* ignore */
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        if (isUi) this.creatingUi.set(false); else this.creatingBos.set(false);
        this.stageError.set(err?.error?.error ?? err?.message ?? 'Failed to create master ticket');
        alert(this.stageError());
        this.cdr.detectChanges();
      },
    });
  }

  runAllChecks(): void {
    if (this.runningAll()) return;
    this.runningAll.set(true);
    this.stageError.set(null);
    this.api.runChecks(this.release.releaseId, this.stage.id).subscribe({
      next: () => {
        this.runningAll.set(false);
        this.refresh.emit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.runningAll.set(false);
        this.stageError.set(err?.error?.error ?? err?.message ?? 'Failed to run checks');
        this.cdr.detectChanges();
      },
    });
  }
}