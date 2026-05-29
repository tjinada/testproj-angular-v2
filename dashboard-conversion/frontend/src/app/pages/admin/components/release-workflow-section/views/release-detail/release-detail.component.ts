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
import { ReleaseWorkflowService } from '../../../../../../services/release-workflow.service';
import { Release, ReleaseComponents, ReleaseMetadata, ReleaseStatus, Stage, StageStatus, SubStep, SubStepTrack } from '../../../../../../models/release-workflow.model';
import { StageViewComponent } from '../../stage-view/stage-view.component';
import { AuthService } from '../../../../../../services/auth.service';
import { Admin } from '../../../../../../models/admin.models';
import { normalizeSheriff, usernameFromEmail } from '../../../../../../utils/sheriff.util';
import {
  normalizeReleaseComponents,
  selectedReleaseComponentsLabel,
  visibleStagesForRelease,
  visibleSubStepsForRelease,
} from '../../../../../../utils/release-components.util';

type ReleaseDetailTab = 'details' | 'stages';
type BasicEditableKey = 'title' | 'sheriff' | 'backupSheriff' | 'releaseComponents' | 'preProdDate' | 'prodDate' | 'jiraTracker';

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
  readonly basicComponentsDraft = signal<ReleaseComponents>(normalizeReleaseComponents());
  readonly basicSaving = signal<boolean>(false);
  readonly admins = signal<Admin[]>([]);
  readonly adminsLoading = signal<boolean>(false);

  /** Stage ID currently shown in the right pane. */
  readonly activeStageId = signal<string | null>(null);

  /** True until the user explicitly clicks a stage; auto-selection wins until then. */
  private userPickedStage = false;

  readonly visibleStages = computed<Stage[]>(() => {
    const release = this.release();
    return release ? visibleStagesForRelease(release) : [];
  });

  readonly activeStage = computed<Stage | null>(() => {
    const id = this.activeStageId();
    if (!id) return null;
    return this.visibleStages().find((s) => s.id === id) ?? null;
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
        this.applyLoadedRelease(release);
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

  private applyLoadedRelease(release: Release): void {
    this.release.set(release);
    const visibleStages = visibleStagesForRelease(release);
    if (!this.userPickedStage || !visibleStages.some((stage) => stage.id === this.activeStageId())) {
      this.activeStageId.set(this.pickDefaultStageId(release));
    }
  }

  private refreshAfterStageAction(): void {
    this.error.set(null);
    this.api.getById(this.releaseId).subscribe({
      next: (release) => {
        this.applyLoadedRelease(release);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to refresh release after stage action', err);
        this.error.set(err?.error?.error ?? 'Failed to refresh release');
        this.cdr.detectChanges();
      },
    });
  }

  /** First in-progress stage, then first ready stage, then Stage 1. */
  private pickDefaultStageId(r: Release): string {
    const visibleStages = visibleStagesForRelease(r);
    const inProgress = visibleStages.find((s) => s.status === 'in_progress');
    if (inProgress) return inProgress.id;
    const ready = visibleStages.find((s) => s.status === 'ready');
    if (ready) return ready.id;
    return visibleStages[0]?.id ?? '';
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
    if ((key === 'sheriff' || key === 'backupSheriff') && this.admins().length === 0) {
      this.loadAdmins();
    }
    this.error.set(null);
    this.editingBasicKey.set(key);
    this.basicDraft.set(this.basicFieldValue(release, key));
    this.basicComponentsDraft.set(normalizeReleaseComponents(release.releaseComponents));
  }

  cancelBasicEdit(): void {
    this.editingBasicKey.set(null);
    this.basicDraft.set('');
    this.basicComponentsDraft.set(normalizeReleaseComponents());
  }

  isEditingBasic(key: BasicEditableKey): boolean {
    return this.editingBasicKey() === key;
  }

  canSaveBasicEdit(): boolean {
    const key = this.editingBasicKey();
    if (!key) return false;

    if (key === 'releaseComponents') {
      const components = this.basicComponentsDraft();
      return components.cdbui || components.cdbbos;
    }

    const value = this.basicDraft().trim();
    if (key === 'title') return value.length > 0;
    if (key === 'sheriff') return normalizeSheriff(value).length > 0;
    return true;
  }

  setBasicReleaseComponent(component: keyof ReleaseComponents, checked: boolean): void {
    this.basicComponentsDraft.update((current) => ({
      ...current,
      [component]: checked,
    }));
  }

  saveBasicEdit(): void {
    const release = this.release();
    const key = this.editingBasicKey();
    if (!release || !key || this.basicSaving()) return;

    const raw = this.basicDraft().trim();
    const textValue = raw;

    let patch: Partial<Pick<Release, 'title' | 'sheriff' | 'backupSheriff'>> & {
      releaseComponents?: Partial<ReleaseComponents>;
      metadata?: Partial<ReleaseMetadata>;
    };
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
    } else if (key === 'backupSheriff') {
      patch = { backupSheriff: normalizeSheriff(textValue) || null };
    } else if (key === 'releaseComponents') {
      const releaseComponents = normalizeReleaseComponents(this.basicComponentsDraft());
      if (!releaseComponents.cdbui && !releaseComponents.cdbbos) {
        this.error.set('Select at least one release component.');
        return;
      }
      patch = { releaseComponents };
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
    if (key === 'backupSheriff') return r.backupSheriff ?? '';
    if (key === 'releaseComponents') return selectedReleaseComponentsLabel(r);
    return r.metadata[key] ?? '';
  }

  usernameFromEmail(email: string): string {
    return usernameFromEmail(email);
  }

  editableSubSteps(stage: Stage, release: Release): SubStep[] {
    return visibleSubStepsForRelease(stage, release).filter((s) => !!s.editableField);
  }

  detailTracks(stage: Stage, release: Release): SubStepTrack[] {
    const seen = new Set<SubStepTrack>();
    for (const subStep of this.editableSubSteps(stage, release)) {
      seen.add(this.detailTrack(subStep));
    }
    return (['generic', 'cdbui', 'cdbbos'] as const).filter((track) => seen.has(track));
  }

  editableSubStepsByTrack(stage: Stage, release: Release, track: SubStepTrack): SubStep[] {
    return this.editableSubSteps(stage, release).filter((subStep) => this.detailTrack(subStep) === track);
  }

  private detailTrack(subStep: SubStep): SubStepTrack {
    return subStep.track === 'cdbui' || subStep.track === 'cdbbos' ? subStep.track : 'generic';
  }

  detailTrackLabel(track: SubStepTrack): string {
    switch (track) {
      case 'cdbui':
        return 'CDB UI';
      case 'cdbbos':
        return 'CDB BOS';
      default:
        return 'General';
    }
  }

  detailsStages(r: Release): Stage[] {
    return visibleStagesForRelease(r).filter((stage) => this.editableSubSteps(stage, r).length > 0);
  }

  fieldValueByPath(path: string | null, r: Release): string {
    if (!path) return 'Not set';
    if (path.startsWith('branches.')) {
      const key = path.slice('branches.'.length) as keyof Release['metadata']['branches'];
      return r.metadata.branches?.[key] ?? 'Not set';
    }
    return (r.metadata as any)[path] ?? 'Not set';
  }

  fieldLinkByPath(path: string | null, r: Release): string | null {
    const value = this.fieldValueByPath(path, r);
    return /^https?:\/\//i.test(value) ? value : null;
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
    return this.visibleStages().filter((s) => s.status === 'complete').length;
  }

  totalStages(): number {
    return this.visibleStages().length;
  }

  subStepsComplete(stage: Stage, release: Release): number {
    return visibleSubStepsForRelease(stage, release).filter((s) => s.state === 'checked' || s.state === 'n_a').length;
  }

  visibleSubStepCount(stage: Stage, release: Release): number {
    return visibleSubStepsForRelease(stage, release).length;
  }

  stageProgressPct(stage: Stage, release: Release): number {
    const visibleSubStepCount = this.visibleSubStepCount(stage, release);
    if (!visibleSubStepCount) return 0;
    return Math.round((this.subStepsComplete(stage, release) / visibleSubStepCount) * 100);
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
      case 'blocked': return 'Blocked';
      case 'complete': return 'Complete';
      case 'aborted': return 'Aborted';
      default: return status;
    }
  }

  formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ----- locked stage helper for the empty-pane message -----

  /** When the active stage is locked, return the names of stages it's waiting on. */
  blockingStageNames(): string[] {
    const stage = this.activeStage();
    const r = this.release();
    if (!stage || !r) return [];
    return stage.dependsOn
      .map((id) => r.stages.find((s) => s.id === id))
      .filter((s): s is Stage => !!s && s.status !== 'complete' && s.status !== 'skipped')
      .map((s) => s.name);
  }

  backupSheriffLabel(r: Release): string {
    return r.backupSheriff || 'Not set';
  }

  releaseComponentsLabel(r: Release): string {
    return selectedReleaseComponentsLabel(r);
  }

  // ----- actions -----

  onBack(): void {
    this.back.emit();
  }

  onStageRefresh(): void {
    this.focusedSubStepId.set(null);
    this.refreshAfterStageAction();
  }
}