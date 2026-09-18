import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ReleasesListComponent } from './views/releases-list/releases-list.component';
import { ReleaseDetailComponent } from './views/release-detail/release-detail.component';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { AuthService } from '../../../../services/auth.service';
import { usernameFromEmail } from '../../../../utils/sheriff.util';

type View = 'list' | 'detail';

@Component({
  selector: 'app-release-workflow-section',
  standalone: true,
  imports: [FormsModule, ReleasesListComponent, ReleaseDetailComponent],
  templateUrl: './release-workflow-section.component.html',
  styleUrl: './release-workflow-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseWorkflowSectionComponent {
  private readonly api = inject(ReleaseWorkflowService);
  private readonly auth = inject(AuthService);

  private readonly listView = viewChild(ReleasesListComponent);
  private readonly detailView = viewChild(ReleaseDetailComponent);

  readonly view = signal<View>('list');
  readonly selectedReleaseId = signal<string | null>(null);

  // ── close-release modal ──────────────────────────────────────────────────
  // Hosted here rather than in either view so the confirm, error and refresh
  // logic exists once and both entry points share it.
  readonly abortTarget = signal<string | null>(null);
  readonly abortSubmitting = signal<boolean>(false);
  readonly abortError = signal<string | null>(null);
  abortComment = '';
  // ─────────────────────────────────────────────────────────────────────────

  goToList(): void {
    this.selectedReleaseId.set(null);
    this.view.set('list');
  }

  goToDetail(releaseId: string): void {
    this.selectedReleaseId.set(releaseId);
    this.view.set('detail');
  }

  openAbort(releaseId: string): void {
    this.abortComment = '';
    this.abortError.set(null);
    this.abortSubmitting.set(false);
    this.abortTarget.set(releaseId);
  }

  closeAbort(): void {
    if (this.abortSubmitting()) return;
    this.abortTarget.set(null);
  }

  submitAbort(): void {
    const releaseId = this.abortTarget();
    if (!releaseId) return;

    const comment = this.abortComment.trim();
    if (!comment) {
      this.abortError.set('A comment is required to close a release.');
      return;
    }

    this.abortSubmitting.set(true);
    this.abortError.set(null);

    this.api.abort(releaseId, comment, this.actor()).subscribe({
      next: () => {
        this.abortSubmitting.set(false);
        this.abortTarget.set(null);
        this.refreshActiveView();
      },
      error: (err) => {
        this.abortSubmitting.set(false);
        this.abortError.set(err?.error?.error ?? 'Failed to close the release.');
      },
    });
  }

  /** Reload whichever view is showing so it picks up the closure. */
  private refreshActiveView(): void {
    this.listView()?.load();
    this.detailView()?.load();
  }

  private actor(): string | undefined {
    const email = this.auth.currentUser()?.email;
    return email ? usernameFromEmail(email) || undefined : undefined;
  }
}
