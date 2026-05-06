import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Release, Stage } from '../../../../models/release-workflow.model';

/**
 * Stage 3 — Build Stabilization (T-7)
 *
 * SKELETON PLACEHOLDER. Per-stage owner: replace the body of the template
 * with this stage's real sub-step UI and wire actions to
 * ReleaseWorkflowService.updateSubStep / runChecks.
 *
 * The sub-step IDs and automated-check IDs are pre-declared in
 * backend/src/services/release-workflow.template.ts — do not invent new
 * IDs in this component; use what's already on `stage.subSteps` and
 * `stage.automatedChecks`.
 */
@Component({
  selector: 'app-stage3-build-stabilization',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './stage3-build-stabilization.component.html',
  styleUrl: './stage3-build-stabilization.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Stage3BuildStabilizationComponent {
  @Input({ required: true }) stage!: Stage;
  @Input({ required: true }) release!: Release;
}
