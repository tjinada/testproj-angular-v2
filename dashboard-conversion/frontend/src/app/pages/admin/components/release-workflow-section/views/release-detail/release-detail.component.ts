import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { Release, ReleaseMetadata, ReleaseStatus, Stage, StageStatus, SubStep } from '../../../../models/release-workflow.model';
import { StageViewComponent } from '../../stage-view/stage-view.component';
import { AuthService } from '../../../../../../services/auth.service';
import { Admin } from '../../../../../../models/admin.models';
import { normalizeSheriff, usernameFromEmail } from '../../../../../../utils/sheriff.util';

type ReleaseDetailTab = 'details' | 'stages';
type BasicEditableKey = 'title' | 'sheriff' | 'preProdDate' | 'prodDate' | 'jiraTracker';

@Component({
  selector: 'app-release-detail',
  standalone: true,
  imports: [CommonModule, StageViewComponent],
  templateUrl: './release-detail.component.html',
  styleUrl: './release-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseDetailComponent implements OnInit {
  @Input({ required: true }) releaseId!: string;
  @Output() back = new EventEmitter<void>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly auth = inject(AuthService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly release = signal<Release | null>(null);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  readonly activeTab = signal<ReleaseDetailTab>('details');
  readonly focusedSubStepId = signal<string | null>(null);

  readonly editingBasicKey = signal<BasicEditableKey | null>(null);
  readonly basicDraft = signal<string>('');
  readonly basicSaving = signal<boolean>(false);
  readonly admins = signal<Admin[]>([]);
  readonly adminsLoading = signal<boolean>(false);

  /** Stage ID currently shown in the right pane. */
  readonly activeStageId = signal<string | null>(null);

  /** True until the user explicitly clicks a stage; auto-selection wins until then. */
  private userPickedStage = false;

  readonly activeStage = computed<Stage | null>(() => {
    const r = this.release();
    const id = this.activeStageId();
    if (!r || !id) return null;
    return r.stages.find((s) => s.id === id) ?? null;
  });

  ngOnInit(): void {
    this.load();
  }

  loadAdmins(): void {
    if (this.adminsLoading() || this.admins().length > 0) return;
    this.adminsLoading.set(true);
    this.auth.getAdmins().subscribe({
      next: (res) => {
        this.admins.set(res.admins ?? []);
        this.adminsLoading.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.adminsLoading.set(false);
        console.error('Failed to load admins for sheriff suggestions', err);
      },
    });
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getById(this.releaseId).subscribe({
      next: (release) => {
        this.release.set(release);
        if (!this.userPickedStage) {
          this.activeStageId.set(this.pickDefaultStageId(release));
        }
        this.loading.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load release', err);
        this.error.set(err?.error?.error ?? 'Failed to load release');
        this.loading.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  /** First in-progress stage, then first ready stage, then Stage 1. */
  private pickDefaultStageId(r: Release): string {
    const inProgress = r.stages.find((s) => s.status === 'in_progress');
    if (inProgress) return inProgress.id;
    const ready = r.stages.find((s) => s.status === 'ready');
    if (ready) return ready.id;
    return r.stages[0]?.id ?? '';
  }

  // ----- rail interactions -----

  selectStage(stageId: string): void {
    this.userPickedStage = true;
    this.activeStageId.set(stageId);
    this.focusedSubStepId.set(null);
  }

  setActiveTab(tab: ReleaseDetailTab): void {
    this.activeTab.set(tab);
  }

  isTabActive(tab: ReleaseDetailTab): boolean {
    return this.activeTab() === tab;
  }

  startBasicEdit(key: BasicEditableKey): void {
    const release = this.release();
    if (!release) return;
    if (key === 'sheriff' && this.admins().length === 0) {
      this.loadAdmins();
    }
    this.error.set(null);
    this.editingBasicKey.set(key);
    this.basicDraft.set(this.basicFieldValue(release, key));
  }

  cancelBasicEdit(): void {
    this.editingBasicKey.set(null);
    this.basicDraft.set('');
  }

  isEditingBasic(key: BasicEditableKey): boolean {
    return this.editingBasicKey() === key;
  }

  canSaveBasicEdit(): boolean {
    const key = this.editingBasicKey();
    if (!key) return false;

    const value = this.basicDraft().trim();
    if (key === 'title') return value.length > 0;
    if (key === 'sheriff') return normalizeSheriff(value).length > 0;
    return true;
  }

  saveBasicEdit(): void {
    const release = this.release();
    const key = this.editingBasicKey();
    if (!release || !key || this.basicSaving()) return;

    const raw = this.basicDraft().trim();
    const textValue = raw;

    let patch: Partial<Pick<Release, 'title' | 'sheriff'>> & { metadata?: Partial<ReleaseMetadata> };
    if (key === 'title') {
      if (!textValue) {
        this.error.set('Title cannot be blank.');
        return;
      }
      patch = { title: textValue };
    } else if (key === 'sheriff') {
      const sheriff = normalizeSheriff(textValue);
      if (!sheriff) {
        this.error.set('Sheriff cannot be blank.');
        return;
      }
      patch = { sheriff };
    } else {
      patch = { metadata: { [key]: textValue || null } };
    }

    this.basicSaving.set(true);
    this.error.set(null);
    this.api.update(this.releaseId, patch).subscribe({
      next: ({ release: updated }) => {
        this.release.set(updated);
        this.basicSaving.set(false);
        this.cancelBasicEdit();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to update release field');
        this.basicSaving.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  basicFieldValue(r: Release, key: BasicEditableKey): string {
    if (key === 'title') return r.title;
    if (key === 'sheriff') return r.sheriff;
    return (r.metadata as any)[key] ?? '';
  }

  usernameFromEmail(email: string): string {
    return usernameFromEmail(email);
  }

  editableSubSteps(stage: Stage): SubStep[] {
    return stage.subSteps.filter((s) => !!s.editableField);
  }

  detailsStages(r: Release): Stage[] {
    return r.stages.filter((stage) => this.editableSubSteps(stage).length > 0);
  }

  fieldValueByPath(path: string | null, r: Release): string {
    if (!path) return 'Not set';
    if (path.startsWith('branches.')) {
      const key = path.slice('branches.'.length) as keyof Release['metadata']['branches'];
      return r.metadata.branches?.[key] ?? 'Not set';
    }
    return (r.metadata as any)[path] ?? 'Not set';
  }

  jumpToStageEditor(stageId: string, subStepId: string): void {
    this.userPickedStage = true;
    this.activeStageId.set(stageId);
    this.focusedSubStepId.set(subStepId);
    this.activeTab.set('stages');
  }

  isActive(stageId: string): boolean {
    return this.activeStageId() === stageId;
  }

  // ----- presentational helpers -----

  stagesComplete(): number {
    return this.release()?.stages.filter((s) => s.status === 'complete').length ?? 0;
  }

  totalStages(): number {
    return this.release()?.stages.length ?? 10;
  }

  subStepsComplete(stage: Stage): number {
    return stage.subSteps.filter((s) => s.state === 'checked' || s.state === 'n_a').length;
  }

  stageProgressPct(stage: Stage): number {
    if (!stage.subSteps.length) return 0;
    return Math.round((this.subStepsComplete(stage) / stage.subSteps.length) * 100);
  }

  stageRailClass(stage: Stage): string {
    const parts = [`rail-stage`, `rail-stage--${stage.status}`];
    if (this.isActive(stage.id)) parts.push('rail-stage--active');
    if (stage.kind === 'parallel') parts.push('rail-stage--parallel');
    return parts.join(' ');
  }

  stageStatusLabel(status: StageStatus): string {
    switch (status) {
      case 'locked':      return 'locked';
      case 'ready':       return 'ready';
      case 'in_progress': return 'in progress';
      case 'complete':    return 'complete';
      case 'skipped':     return 'skipped';
      default:            return status;
    }
  }

  releaseStatusClass(status: ReleaseStatus): string {
    return `status-pill status-pill--${status.replace('_', '-')}`;
  }

  releaseStatusLabel(status: ReleaseStatus): string {
    switch (status) {
      case 'not_started': return 'Not started';
      case 'in_progress': return 'In progress';
      case 'blocked':     return 'Blocked';
      case 'complete':    return 'Complete';
      case 'aborted':     return 'Aborted';
      default:            return status;
    }
  }

  formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ----- locked stage helper for the empty-pane message -----

  /** When the active stage is locked, return the names of stages it's waiting on. */
  blockingStageNames(): string[] {
    const stage = this.activeStage();
    const r = this.release();
    if (!stage || !r) return [];
    return stage.dependsOn
      .map((id) => r.stages.find((s) => s.id === id))
      .filter((s): s is Stage => !!s && s.status !== 'complete')
      .map((s) => s.name);
  }

  // ----- actions -----

  onBack(): void {
    this.back.emit();
  }
}
