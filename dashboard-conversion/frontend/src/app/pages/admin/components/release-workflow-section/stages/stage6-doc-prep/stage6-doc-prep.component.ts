import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Release, Stage } from '../../../../models/release-workflow.model';

/**
 * Stage 6 — Documentation Prep (parallel)
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
  selector: 'app-stage6-doc-prep',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './stage6-doc-prep.component.html',
  styleUrl: './stage6-doc-prep.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Stage6DocPrepComponent {
  @Input({ required: true }) stage!: Stage;
  @Input({ required: true }) release!: Release;
}
