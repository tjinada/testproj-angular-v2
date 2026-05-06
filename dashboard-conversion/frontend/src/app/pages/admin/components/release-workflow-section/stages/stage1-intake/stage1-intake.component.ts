import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Release, Stage } from '../../../../models/release-workflow.model';

/**
 * Stage 1 — Intake & Setup
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
}
