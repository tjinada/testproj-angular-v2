import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReleaseWorkflowService } from '../../../../../../services/release-workflow.service';
import { Release, ReleaseComponents, ReleaseStatus, ReleaseType } from '../../../../../../models/release-workflow.model';
import { AuthService } from '../../../../../../services/auth.service';
import { Admin } from '../../../../../../models/admin.models';
import { normalizeSheriff, usernameFromEmail } from '../../../../../../utils/sheriff.util';
import { releaseIdExample, releaseIdValidationMessage } from '../../../../../../utils/release-id.util';

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
  @Output() abortRelease = new EventEmitter<string>();

  private readonly earlyRetrofitReleaseStageId = 'stage3-early-retrofit-release';

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

  // ── modal state ──────────────────────────────────────────────────────────
  readonly showModal = signal<boolean>(false);
  readonly modalSubmitting = signal<boolean>(false);
  readonly modalError = signal<string | null>(null);

  modalReleaseId = '';
  modalTitle = '';
  modalType = signal<ReleaseType>('bundle');
  modalUiSheriff = '';
  modalUiBackupSheriff = '';
  modalBosSheriff = '';
  modalBosBackupSheriff = '';
  readonly modalReleaseComponents = signal<ReleaseComponents>({ cdbui: false, cdbbos: false });
  // ─────────────────────────────────────────────────────────────────────────

  // ── retrofit reminder logic ──────────────────────────────────────────────
  
  /** Find the earliest in-progress release by creation date */
  readonly earliestInProgressRelease = computed(() => {
    const inProgress = this.releases().filter((r) => r.status === 'in_progress');
    if (inProgress.length === 0) return null;

    const earliestCreatedAt = Math.min(
      ...inProgress.map((r) => new Date(r.createdAt).getTime())
    );
    return inProgress.find((r) => new Date(r.createdAt).getTime() === earliestCreatedAt) || null;
  });

  readonly retrofitReminders = computed(() => {
    const activeRelease = this.earliestInProgressRelease();
    if (!activeRelease) return [];

    // Find releases created after the earliest in-progress release
    const activeCreatedAt = new Date(activeRelease.createdAt).getTime();
    const newReleases = this.releases().filter((r) => {
      const createdAt = new Date(r.createdAt).getTime();
      return createdAt > activeCreatedAt;
    });

    // Filter to only releases that haven't completed the retrofit stage
    return newReleases.filter((r) => !this.isRetrofitStageComplete(r));
  });

  readonly hasRetrofitReminders = computed(() => this.retrofitReminders().length > 0);

  readonly retrofitReminderMessage = computed(() => {
    const reminders = this.retrofitReminders();
    if (reminders.length === 0) return '';

    const activeRelease = this.earliestInProgressRelease();
    const activeReleaseName = activeRelease ? activeRelease.releaseId : '';

    const releaseNames = reminders
      .map((r) => `${r.releaseId}`)
      .join(', ');

    const pluralSuffix = reminders.length === 1 ? '' : 's';
    const activeReleaseInfo = activeReleaseName ? ` [${activeReleaseName}]` : '';
    return `New release${pluralSuffix} created during active release${activeReleaseInfo}: ${releaseNames}. ` +
           `Please complete the retrofit stage${pluralSuffix} for the mentioned release${pluralSuffix}.`;
  });
  // ─────────────────────────────────────────────────────────────────────────

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

  // ── modal ────────────────────────────────────────────────────────────────

  openModal(): void {
    this.modalReleaseId = '';
    this.modalTitle = '';
    this.modalType.set('bundle');
    this.modalUiSheriff = '';
    this.modalUiBackupSheriff = '';
    this.modalBosSheriff = '';
    this.modalBosBackupSheriff = '';
    this.modalReleaseComponents.set({ cdbui: false, cdbbos: false });
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

  modalReleaseIdExample(): string {
    return releaseIdExample(this.modalType());
  }

  modalReleaseIdValidationMessage(): string | null {
    return releaseIdValidationMessage(this.modalReleaseId, this.modalType());
  }

  setModalReleaseComponent(component: keyof ReleaseComponents, checked: boolean): void {
    this.modalReleaseComponents.update((current) => ({
      ...current,
      [component]: checked,
    }));
  }

  onModalSubmit(): void {
    this.modalError.set(null);

    if (!this.modalReleaseId.trim()) {
      this.modalError.set('Release ID is required.');
      return;
    }
    const releaseIdError = this.modalReleaseIdValidationMessage();
    if (releaseIdError) {
      this.modalError.set(releaseIdError);
      return;
    }
    if (!this.modalTitle.trim()) {
      this.modalError.set('Title is required.');
      return;
    }

    const missingSheriffMessage = this.missingModalSheriffMessage();
    if (missingSheriffMessage) {
      this.modalError.set(missingSheriffMessage);
      return;
    }
    if (!this.hasSelectedReleaseComponents()) {
      this.modalError.set('Select at least one release component.');
      return;
    }

    const uiSheriff = this.modalReleaseComponents().cdbui
      ? normalizeSheriff(this.modalUiSheriff)
      : null;
    const uiBackupSheriff = this.modalReleaseComponents().cdbui
      ? normalizeSheriff(this.modalUiBackupSheriff) || null
      : null;
    const bosSheriff = this.modalReleaseComponents().cdbbos
      ? normalizeSheriff(this.modalBosSheriff)
      : null;
    const bosBackupSheriff = this.modalReleaseComponents().cdbbos
      ? normalizeSheriff(this.modalBosBackupSheriff) || null
      : null;

    this.modalSubmitting.set(true);

    this.api.create({
      releaseId: this.modalReleaseId.trim(),
      title: this.modalTitle.trim(),
      type: this.modalType(),
      uiSheriff,
      uiBackupSheriff,
      bosSheriff,
      bosBackupSheriff,
      releaseComponents: this.modalReleaseComponents(),
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

  // ─────────────────────────────────────────────────────────────────────────

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

  hasSelectedReleaseComponents(): boolean {
    const components = this.modalReleaseComponents();
    return components.cdbui || components.cdbbos;
  }

  canSubmitModal(): boolean {
    if (this.modalSubmitting()) return false;
    if (!this.modalReleaseId.trim()) return false;
    if (this.modalReleaseIdValidationMessage()) return false;
    if (!this.modalTitle.trim()) return false;
    if (!this.hasSelectedReleaseComponents()) return false;
    return !this.missingModalSheriffMessage();
  }

  private missingModalSheriffMessage(): string | null {
    if (this.loadingAdmins()) {
      return 'Loading admin list...';
    }
    if (this.admins().length === 0) {
      return this.adminsError() || 'Admin list is unavailable.';
    }

    const components = this.modalReleaseComponents();
    if (components.cdbui && !this.isValidAdminSheriff(this.modalUiSheriff)) {
      return this.modalUiSheriff.trim()
        ? 'CDB UI sheriff must match an admin username.'
        : 'CDB UI sheriff is required.';
    }
    if (components.cdbui && !this.isOptionalAdminSheriff(this.modalUiBackupSheriff)) {
      return 'CDB UI backup sheriff must match an admin username.';
    }
    if (components.cdbbos && !this.isValidAdminSheriff(this.modalBosSheriff)) {
      return this.modalBosSheriff.trim()
        ? 'CDB BOS sheriff must match an admin username.'
        : 'CDB BOS sheriff is required.';
    }
    if (components.cdbbos && !this.isOptionalAdminSheriff(this.modalBosBackupSheriff)) {
      return 'CDB BOS backup sheriff must match an admin username.';
    }
    return null;
  }

  private validAdminUsernames(): Set<string> {
    return new Set(this.admins().map((admin) => usernameFromEmail(admin.email).toLowerCase()));
  }

  private isValidAdminSheriff(value: string): boolean {
    const normalized = normalizeSheriff(value).toLowerCase();
    return normalized.length > 0 && this.validAdminUsernames().has(normalized);
  }

  private isOptionalAdminSheriff(value: string): boolean {
    const normalized = normalizeSheriff(value);
    return normalized.length === 0 || this.validAdminUsernames().has(normalized.toLowerCase());
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

  /** Hand the release up to the section root, which owns the close modal. */
  onAbort(release: Release, ev: Event): void {
    ev.stopPropagation();
    this.abortRelease.emit(release.releaseId);
  }

  isDeleting(releaseId: string): boolean {
    return this.deletingId() === releaseId;
  }

  private isRetrofitStageComplete(release: Release): boolean {
    const retrofitStage = release.stages.find((s) => s.id === this.earlyRetrofitReleaseStageId);
    return retrofitStage ? retrofitStage.status === 'complete' : false;
  }
}