import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { Release, ReleaseStatus, ReleaseType } from '../../../../models/release-workflow.model';
import { AuthService } from '../../../../../../services/auth.service';
import { Admin } from '../../../../../../models/admin.models';
import { normalizeSheriff, usernameFromEmail } from '../../../../../../utils/sheriff.util';

@Component({
  selector: 'app-releases-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './releases-list.component.html',
  styleUrl: './releases-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleasesListComponent implements OnInit {
  @Output() openRelease = new EventEmitter<string>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly auth = inject(AuthService);

  readonly releases = signal<Release[]>([]);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  readonly deletingId = signal<string | null>(null);

  readonly admins = signal<Admin[]>([]);
  readonly adminsError = signal<string | null>(null);
  readonly loadingAdmins = signal<boolean>(false);

  // ----- modal state -----
  readonly showModal = signal<boolean>(false);
  readonly modalSubmitting = signal<boolean>(false);
  readonly modalError = signal<string | null>(null);

  modalReleaseId = '';
  modalTitle = '';
  modalType = signal<ReleaseType>('bundle');
  modalSheriff = '';
  // -------------------------

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (data) => {
        this.releases.set(data);
        this.loading.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load releases', err);
        this.error.set('Failed to load releases');
        this.loading.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  // ----- modal -----

  openModal(): void {
    this.modalReleaseId = '';
    this.modalTitle = '';
    this.modalType.set('bundle');
    this.modalSheriff = '';
    this.modalError.set(null);
    this.modalSubmitting.set(false);
    this.showModal.set(true);
    this.loadAdmins();
  }

  closeModal(): void {
    this.showModal.set(false);
  }

  setModalType(t: ReleaseType): void {
    this.modalType.set(t);
  }

  onModalSubmit(): void {
    this.modalError.set(null);

    if (!this.modalReleaseId.trim()) {
      this.modalError.set('Release ID is required.');
      return;
    }
    if (!this.modalTitle.trim()) {
      this.modalError.set('Title is required.');
      return;
    }

    const sheriff = normalizeSheriff(this.modalSheriff);
    if (!sheriff) {
      this.modalError.set('Sheriff is required.');
      return;
    }

    this.modalSubmitting.set(true);

    this.api.create({
      releaseId: this.modalReleaseId.trim(),
      title: this.modalTitle.trim(),
      type: this.modalType(),
      sheriff: sheriff,
    }).subscribe({
      next: (resp) => {
        this.modalSubmitting.set(false);
        this.showModal.set(false);
        this.load();
        this.openRelease.emit(resp.release.releaseId);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to create release', err);
        this.modalError.set(err?.error?.error ?? err?.message ?? 'Failed to create release');
        this.modalSubmitting.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  // ----- presentational helpers -----

  currentStageName(r: Release): string {
    const active = r.stages.find((s) => s.status === 'in_progress')
      ?? r.stages.find((s) => s.status === 'ready')
      ?? r.stages.at(-1);
    return active ? `${active.name}` : '—';
  }

  stagesComplete(r: Release): number {
    return r.stages.filter((s) => s.status === 'complete').length;
  }

  totalStages(r: Release): number {
    return r.stages.length;
  }

  progressPct(r: Release): number {
    return Math.round((this.stagesComplete(r) / Math.max(this.totalStages(r), 1)) * 100);
  }

  statusClass(status: ReleaseStatus): string {
    return `status-pill status-pill--${status.replace('_', '-')}`;
  }

  statusLabel(status: ReleaseStatus): string {
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
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  onRowClick(releaseId: string): void {
    this.openRelease.emit(releaseId);
  }

  private loadAdmins(): void {
    this.loadingAdmins.set(true);
    this.adminsError.set(null);

    this.auth.getAdmins().subscribe({
      next: (res) => {
        this.admins.set(res.admins ?? []);
        this.loadingAdmins.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load admins for sheriff suggestions', err);
        this.adminsError.set('Failed to load admins');
        this.loadingAdmins.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  usernameFromEmail(email: string): string {
    return usernameFromEmail(email);
  }

  onDelete(release: Release, ev: Event): void {
    ev.stopPropagation();
    const ok = globalThis.confirm(
      `Delete release ${release.releaseId}?\n\nThis removes "${release.title}" and all its stage state. This cannot be undone.`,
    );
    if (!ok) return;

    this.deletingId.set(release.releaseId);
    this.error.set(null);

    this.api.delete(release.releaseId).subscribe({
      next: () => {
        this.deletingId.set(null);
        this.load();   // reload list; load() will call detectChanges
      },
      error: (err) => {
        console.error('Failed to delete release', err);
        this.error.set(err?.error?.error ?? `Failed to delete ${release.releaseId}`);
        this.deletingId.set(null);
        this.cdr.detectChanges();
      },
    });
  }

  isDeleting(releaseId: string): boolean {
    return this.deletingId() === releaseId;
  }
}
