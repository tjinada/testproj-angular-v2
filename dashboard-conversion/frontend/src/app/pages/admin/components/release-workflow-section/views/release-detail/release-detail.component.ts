import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { Release, Stage, StageStatus } from '../../../../models/release-workflow.model';

import { Stage1IntakeComponent } from '../../stages/stage1-intake/stage1-intake.component';
import { Stage2BranchingComponent } from '../../stages/stage2-branching/stage2-branching.component';
import { Stage3BuildStabilizationComponent } from '../../stages/stage3-build-stabilization/stage3-build-stabilization.component';
import { Stage4MobileBuildComponent } from '../../stages/stage4-mobile-build/stage4-mobile-build.component';
import { Stage5WarPromotionComponent } from '../../stages/stage5-war-promotion/stage5-war-promotion.component';
import { Stage6DocPrepComponent } from '../../stages/stage6-doc-prep/stage6-doc-prep.component';
import { Stage7PreProdComponent } from '../../stages/stage7-pre-prod/stage7-pre-prod.component';
import { Stage8ProdComponent } from '../../stages/stage8-prod/stage8-prod.component';
import { Stage9PostGoLiveComponent } from '../../stages/stage9-post-go-live/stage9-post-go-live.component';
import { Stage10PostMobileComponent } from '../../stages/stage10-post-mobile/stage10-post-mobile.component';

@Component({
  selector: 'app-release-detail',
  standalone: true,
  imports: [
    CommonModule,
    Stage1IntakeComponent,
    Stage2BranchingComponent,
    Stage3BuildStabilizationComponent,
    Stage4MobileBuildComponent,
    Stage5WarPromotionComponent,
    Stage6DocPrepComponent,
    Stage7PreProdComponent,
    Stage8ProdComponent,
    Stage9PostGoLiveComponent,
    Stage10PostMobileComponent,
  ],
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

  /** Stage ID that is currently expanded into its placeholder component. */
  readonly openStageId = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getById(this.releaseId).subscribe({
      next: (release) => {
        this.release.set(release);
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

  // ----- presentational helpers -----

  stagesComplete(): number {
    return this.release()?.stages.filter((s) => s.status === 'complete').length ?? 0;
  }

  totalStages(): number {
    return this.release()?.stages.length ?? 10;
  }

  currentStage(): Stage | null {
    const r = this.release();
    if (!r) return null;
    return (
      r.stages.find((s) => s.status === 'in_progress')
      ?? r.stages.find((s) => s.status === 'ready')
      ?? null
    );
  }

  stageRowClass(stage: Stage): string {
    return `stage-row stage-row--${stage.status} ${stage.kind === 'parallel' ? 'stage-row--parallel' : ''}`;
  }

  isOpen(stageId: string): boolean {
    return this.openStageId() === stageId;
  }

  toggleOpen(stageId: string): void {
    this.openStageId.update((cur) => (cur === stageId ? null : stageId));
  }

  // ----- actions -----

  onBack(): void {
    this.back.emit();
  }

  // ----- formatting -----

  formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  stageStatusLabel(status: StageStatus): string {
    switch (status) {
      case 'locked':      return 'Locked';
      case 'ready':       return 'Ready';
      case 'in_progress': return 'In progress';
      case 'complete':    return 'Complete';
      case 'skipped':     return 'Skipped';
      default:            return status;
    }
  }

  subStepsComplete(stage: Stage): number {
    return stage.subSteps.filter((s) => s.state === 'checked' || s.state === 'n_a').length;
  }
}
