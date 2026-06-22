import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../../services/api.service';
import { TechGovernanceRelease, TechGovernanceReleaseIntake } from '../../../../models';

type EditableRelease = TechGovernanceRelease & { __isNew?: boolean };

@Component({
  selector: 'app-admin-governance-section',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './governance-section.component.html',
  styleUrls: ['./governance-section.component.scss'],
})
export class GovernanceSectionComponent implements OnInit, OnDestroy {
  readonly platformVetoOptions: Array<{ value: number; label: string }> = [
    { value: 0, label: 'Default' },
    { value: 1, label: 'Always Block' },
    { value: 2, label: 'Always Allow' },
  ];

  releases = signal<TechGovernanceRelease[]>([]);
  loading = signal(false);
  error = signal('');
  success = signal('');

  // Track which row is in edit mode (by branch, or '__new__' for the new row)
  editingKey = signal<string | null>(null);
  editBuffer: EditableRelease | null = null;
  saving = signal(false);
  refreshingBranch = signal<string | null>(null);

  // Intakes modal
  intakesModalRelease = signal<TechGovernanceRelease | null>(null);
  intakesEditingId = signal<string | null>(null);
  intakeEditBuffer: TechGovernanceReleaseIntake | null = null;
  intakesSaving = signal(false);
  private previousBodyOverflow = '';

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.loadReleases();
  }

  ngOnDestroy(): void {
    this.unlockBodyScroll();
  }

  async loadReleases(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const data = await this.api.request<TechGovernanceRelease[]>('GET', '/api/tech-governance-releases-intake');
      this.releases.set(Array.isArray(data) ? data : []);
    } catch (err: any) {
      this.error.set(err?.error?.error || 'Failed to load tech governance releases');
    } finally {
      this.loading.set(false);
    }
  }

  // ---- Row editing ----

  startEdit(release: TechGovernanceRelease): void {
    this.editingKey.set(release.branch);
    this.editBuffer = { ...release };
    this.error.set('');
    this.success.set('');
  }

  startAdd(): void {
    this.editingKey.set('__new__');
    this.editBuffer = {
      branch: '',
      details: '',
      intakePageId: '',
      gracePeriodInDays: 0,
      intakes: [],
      __isNew: true,
    };
    this.error.set('');
    this.success.set('');
  }

  cancelEdit(): void {
    this.editingKey.set(null);
    this.editBuffer = null;
  }

  isEditing(release: TechGovernanceRelease | null, key?: string): boolean {
    if (key) return this.editingKey() === key;
    return release ? this.editingKey() === release.branch : false;
  }

  async saveEdit(): Promise<void> {
    if (!this.editBuffer) return;
    const buf = this.editBuffer;

    if (!buf.branch?.trim()) {
      this.error.set('Branch is required');
      return;
    }
    if (!buf.intakePageId?.trim()) {
      this.error.set('Intake Page ID is required');
      return;
    }

    const isNew = !!buf.__isNew;
    const payload = {
      branch: buf.branch.trim(),
      details: buf.details ?? '',
      intakePageId: buf.intakePageId.trim(),
      gracePeriodInDays: Number(buf.gracePeriodInDays) || 0,
      intakes: buf.intakes ?? [],
    };

    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      await this.api.request(isNew ? 'POST' : 'PUT', '/api/tech-governance-releases-intake', payload);
      this.success.set(isNew ? 'Release created successfully' : 'Release updated successfully');
      this.cancelEdit();
      await this.loadReleases();
    } catch (err: any) {
      this.error.set(err?.error?.error || `Failed to ${isNew ? 'create' : 'update'} release`);
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRelease(release: TechGovernanceRelease): Promise<void> {
    if (!confirm(`Are you sure you want to delete release "${release.branch}"?`)) return;
    if (!confirm(`This action is permanent. Confirm deletion of "${release.branch}"?`)) return;

    this.error.set('');
    this.success.set('');
    try {
      await this.api.request('DELETE', '/api/tech-governance-releases-intake', { branch: release.branch });
      this.success.set('Release deleted successfully');
      await this.loadReleases();
    } catch (err: any) {
      this.error.set(err?.error?.error || 'Failed to delete release');
    }
  }

  async refreshIntakes(release: TechGovernanceRelease): Promise<void> {
    const id = release.branch.replace(/^release\//i, '');
    this.refreshingBranch.set(release.branch);
    this.error.set('');
    this.success.set('');
    try {
      await this.api.request('POST', `/api/release-workflow/${encodeURIComponent(id)}/intakes/refresh`, {});
      this.success.set('Intakes refreshed');
      await this.loadReleases();
    } catch (err: any) {
      this.error.set(err?.error?.error || 'Failed to refresh intakes');
    } finally {
      this.refreshingBranch.set(null);
    }
  }

  // ---- Intakes modal ----

  openIntakes(release: TechGovernanceRelease): void {
    this.intakesModalRelease.set(release);
    this.intakesEditingId.set(null);
    this.intakeEditBuffer = null;
    this.lockBodyScroll();
  }

  closeIntakes(): void {
    this.intakesModalRelease.set(null);
    this.intakesEditingId.set(null);
    this.intakeEditBuffer = null;
    this.unlockBodyScroll();
  }

  startIntakeEdit(intake: TechGovernanceReleaseIntake): void {
    this.intakesEditingId.set(intake.id);
    this.intakeEditBuffer = { ...intake };
  }

  cancelIntakeEdit(): void {
    this.intakesEditingId.set(null);
    this.intakeEditBuffer = null;
  }

  async saveIntakeEdit(): Promise<void> {
    const release = this.intakesModalRelease();
    if (!release || !this.intakeEditBuffer) return;

    const updatedIntakes = release.intakes.map((i) =>
      i.id === this.intakeEditBuffer!.id
        ? { ...i, platformVeto: Number(this.intakeEditBuffer!.platformVeto) || 0 }
        : i,
    );

    const payload = {
      branch: release.branch,
      details: release.details,
      intakePageId: release.intakePageId,
      gracePeriodInDays: release.gracePeriodInDays,
      intakes: updatedIntakes,
    };

    this.intakesSaving.set(true);
    try {
      const res = await this.api.request<{ release: TechGovernanceRelease }>(
        'PUT',
        '/api/tech-governance-releases-intake',
        payload,
      );
      const refreshed = res?.release ?? { ...release, intakes: updatedIntakes };
      this.intakesModalRelease.set(refreshed);
      this.releases.update((list) => list.map((r) => (r.branch === refreshed.branch ? refreshed : r)));
      this.cancelIntakeEdit();
    } catch (err: any) {
      this.error.set(err?.error?.error || 'Failed to update intake');
    } finally {
      this.intakesSaving.set(false);
    }
  }

  trackByBranch = (_: number, r: TechGovernanceRelease) => r.branch;
  trackByIntakeId = (_: number, i: TechGovernanceReleaseIntake) => i.id;

  getIntakeUrl(id: string): string {
    return `https://bmo.atlassian.net/wiki/spaces/CHNLTECH/pages/${encodeURIComponent(id)}`;
  }

  getPlatformVetoLabel(value: number): string {
    const match = this.platformVetoOptions.find((option) => option.value === Number(value));
    return match?.label ?? 'Default';
  }

  private lockBodyScroll(): void {
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  private unlockBodyScroll(): void {
    document.body.style.overflow = this.previousBodyOverflow;
  }
}
