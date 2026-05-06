import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ReleasesListComponent } from './views/releases-list/releases-list.component';
import { CreateReleaseComponent } from './views/create-release/create-release.component';
import { ReleaseDetailComponent } from './views/release-detail/release-detail.component';

type View = 'list' | 'create' | 'edit' | 'detail';

@Component({
  selector: 'app-release-workflow-section',
  standalone: true,
  imports: [ReleasesListComponent, CreateReleaseComponent, ReleaseDetailComponent],
  templateUrl: './release-workflow-section.component.html',
  styleUrl: './release-workflow-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseWorkflowSectionComponent {
  readonly view = signal<View>('list');
  readonly selectedReleaseId = signal<string | null>(null);
  readonly editingReleaseId = signal<string | null>(null);

  goToList(): void {
    this.selectedReleaseId.set(null);
    this.editingReleaseId.set(null);
    this.view.set('list');
  }

  goToCreate(): void {
    this.editingReleaseId.set(null);
    this.view.set('create');
  }

  goToEdit(releaseId: string): void {
    this.editingReleaseId.set(releaseId);
    this.view.set('edit');
  }

  goToDetail(releaseId: string): void {
    this.selectedReleaseId.set(releaseId);
    this.view.set('detail');
  }
}
