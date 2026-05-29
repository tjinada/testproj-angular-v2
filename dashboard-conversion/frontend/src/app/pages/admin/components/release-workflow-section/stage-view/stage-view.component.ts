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
  SubStep,
  SubStepState,
  SubStepTrack,
} from '../../../../../models/release-workflow.model';
import { formatCheckResult } from './check-result-display';
import { visibleSubStepsForRelease } from '../../../../../utils/release-components.util';

/**
 * Stage pane — renders one stage's sub-step rows with integrated check status
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

   readonly justSavedIds = signal<Set<string>>(new Set());

  /** Per-row staged input value, keyed by sub-step ID. Cleared on submit/cancel. */
  readonly inputValues = signal<Record<string, string>>({});

  readonly error = signal<string | null>(null);
  readonly highlightedSubStepId = signal<string | null>(null);

  private lastAppliedFocusKey: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['release'] && this.justSavedIds().size > 0) {
      this.justSavedIds.set(new Set());
    }
    this.applyFocusRequest();
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