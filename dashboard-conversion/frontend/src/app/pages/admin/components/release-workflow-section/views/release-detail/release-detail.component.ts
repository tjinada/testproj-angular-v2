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
import { Release, Stage, StageStatus } from '../../../../models/release-workflow.model';
import { StageViewComponent } from '../../stage-view/stage-view.component';

/**
 * Release detail screen.
 *
 * Layout: left rail listing all 10 stages + right pane showing the active
 * stage's sub-steps. The rail is rendered inline; the pane is delegated to
 * StageViewComponent (which owns the per-stage interaction state — editing,
 * running, override, N/A).
 *
 * Active stage selection:
 *   - On load, defaults to the first 'in_progress' stage, falling back to
 *     'ready' if none are in progress, falling back to Stage 1.
 *   - User clicks in the rail are sticky for the rest of the session.
 *
 * Refresh model:
 *   - The pane emits `refresh` after every mutation; we re-fetch the whole
 *     release. This is heavier than patching but keeps the UI honest with
 *     server-computed status (auto-tick reconciliation, stage status
 *     advancement, locked transitions).
 */
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
  private readonly cdr = inject(ChangeDetectorRef);

  readonly release = signal<Release | null>(null);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);

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
      .filter((s): s is Stage => !!s && s.status !== 'complete')
      .map((s) => s.name);
  }

  // ----- actions -----

  onBack(): void {
    this.back.emit();
  }
}
