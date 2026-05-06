import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Output,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { ReleaseType } from '../../../../models/release-workflow.model';

@Component({
  selector: 'app-create-release',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './create-release.component.html',
  styleUrl: './create-release.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateReleaseComponent {
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<string>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);

  // form fields
  releaseId = '';
  title = '';
  type = signal<ReleaseType>('bundle');
  sheriff = '';
  preProdDate = '';
  prodDate = '';
  jiraTracker = '';
  intakePageId = '';

  readonly submitting = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  setType(t: ReleaseType): void {
    this.type.set(t);
  }

  onCancel(): void {
    this.cancel.emit();
  }

  onSubmit(): void {
    this.error.set(null);

    if (!this.releaseId.trim() || !this.title.trim() || !this.sheriff.trim()) {
      this.error.set('Release ID, Title, and Sheriff are required.');
      return;
    }

    this.submitting.set(true);
    this.api
      .create({
        releaseId: this.releaseId.trim(),
        title: this.title.trim(),
        type: this.type(),
        sheriff: this.sheriff.trim(),
        metadata: {
          preProdDate: this.preProdDate || null,
          prodDate: this.prodDate || null,
          jiraTracker: this.jiraTracker.trim() || null,
          intakePageId: this.intakePageId.trim() || null,
        },
      })
      .subscribe({
        next: (resp) => {
          this.submitting.set(false);
          this.created.emit(resp.release.releaseId);
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Create release failed', err);
          const msg =
            err?.error?.error
            ?? err?.message
            ?? 'Failed to create release';
          this.error.set(msg);
          this.submitting.set(false);
          this.cdr.detectChanges();
        },
      });
  }
}
