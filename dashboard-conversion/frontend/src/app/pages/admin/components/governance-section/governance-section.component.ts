import { Component, HostListener, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../../services/api.service';
import { AuthService } from '../../../../services/auth.service';
import { usernameFromEmail } from '../../../../utils/sheriff.util';
import { TechGovernanceRelease, TechGovernanceReleaseIntake } from '../../../../models';
import { AwaitingDiscussionItem, IntakeGateState } from '../../../../models/tech-governance.models';

type EditableRelease = TechGovernanceRelease & { __isNew?: boolean };

type IntakeFilter = 'all' | 'blocking' | 'grace' | 'approved' | 'veto';

type ApprovalAction = 'approve' | 'revoke';

// The intake an approve/revoke popover is open for, and where it sits (fixed to the viewport)
interface ApprovalTarget {
  action: ApprovalAction;
  branch: string;
  intake: TechGovernanceReleaseIntake;
  top: number | null;
  bottom: number | null;
  right: number;
}

interface StatusView {
  tone: IntakeGateState | 'unknown';
  label: string;
  detail: string;
}

// Most urgent first in the intakes modal
const INTAKE_SORT_RANK: Record<IntakeGateState, number> = {
  blocking: 0,
  grace: 1,
  'veto-block': 2,
  'veto-allow': 3,
  approved: 4,
};

const INTAKE_PAGE_BASE_URL = 'https://bmo.atlassian.net/wiki/spaces/CHNLTECH/pages/';
const AWAITING_COLLAPSED_STORAGE_KEY = 'techGovernance.awaitingDiscussion.collapsed';
const POPOVER_GAP_PX = 6;
const POPOVER_EST_HEIGHT_PX = 230;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date-only values (YYYY-MM-DD) are calendar days, so read them as local time, not UTC midnight. */
function parseDate(value: string): Date | null {
  const dateOnly = DATE_ONLY.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 'Nov 27, 2026'; unparseable values (hand-typed Confluence dates) are shown as-is. */
function formatShortDate(value: string | undefined | null): string {
  if (!value) return '';
  const date = parseDate(value);
  return date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : value;
}

function toIsoDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function todayIsoDate(): string {
  return toIsoDate(new Date());
}

/** The day after a YYYY-MM-DD date (first day PRs are blocked once grace ends). */
function nextDay(isoDate: string): string {
  const date = parseDate(isoDate);
  if (!date) return isoDate;
  date.setDate(date.getDate() + 1);
  return toIsoDate(date);
}

/** Collapsed unless the user expanded it before in this browser. */
function readAwaitingCollapsed(): boolean {
  try {
    return localStorage.getItem(AWAITING_COLLAPSED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

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
  sortedReleases = computed(() => {
    const list = this.releases();
    return [...list].sort((a, b) =>
       b.branch.trim().replace(/^release\//i, '').localeCompare(
         a.branch.trim().replace(/^release\//i, ''),
         undefined,
         { numeric: true, sensitivity: 'base' },
       ),
     );
  });
  loading = signal(false);
  error = signal('');
  success = signal('');

  // Track which row is in edit mode (by branch, or '__new__' for the new row)
  editingKey = signal<string | null>(null);
  editBuffer: EditableRelease | null = null;
  saving = signal(false);

  // Intakes modal
  intakesModalRelease = signal<TechGovernanceRelease | null>(null);
  intakesEditingId = signal<string | null>(null);
  intakeEditBuffer: TechGovernanceReleaseIntake | null = null;
  intakesSaving = signal(false);
  private previousBodyOverflow = '';

  readonly intakeFilters: Array<{ value: IntakeFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'blocking', label: 'Blocking PRs' },
    { value: 'grace', label: 'Pending, in grace' },
    { value: 'approved', label: 'Approved' },
    { value: 'veto', label: 'Veto override' },
  ];
  intakeFilter = signal<IntakeFilter>('all');

  // Intakes shown in the modal: filtered by the selected chip, most urgent first
  readonly modalIntakes = computed(() => {
    const release = this.intakesModalRelease();
    if (!release) return [];
    const filter = this.intakeFilter();
    return [...release.intakes]
      .filter((intake) => filter === 'all' || this.filterOf(intake) === filter)
      .sort((a, b) => this.compareIntakes(a, b));
  });

  // Awaiting discussion: pending intakes across releases still open in Release Workflow
  awaitingItems = signal<AwaitingDiscussionItem[]>([]);
  awaitingLoading = signal(false);
  awaitingError = signal('');
  awaitingCollapsed = signal(readAwaitingCollapsed());
  readonly awaitingBlockingCount = computed(
    () => this.awaitingItems().filter((i) => i.intake.gateStatus?.state === 'blocking').length,
  );
  readonly awaitingGraceCount = computed(
    () => this.awaitingItems().filter((i) => i.intake.gateStatus?.state === 'grace').length,
  );
  readonly awaitingReleaseNames = computed(() =>
    [...new Set(this.awaitingItems().map((i) => i.branch.replace(/^release\//i, '')))].join(', '),
  );

  // Approve / revoke popover (one at a time, shared by the panel and the intakes modal)
  approvalTarget = signal<ApprovalTarget | null>(null);
  approvalSaving = signal(false);
  approvalError = signal('');
  meetingDate = todayIsoDate();
  // The popover is fixed to the viewport, so any scroll would detach it from its row
  private readonly closeApprovalOnScroll = () => this.closeApproval();

  constructor(
    private api: ApiService,
    private auth: AuthService,
  ) {}

  ngOnInit(): void {
    this.loadReleases();
    void this.loadAwaiting();
  }

  ngOnDestroy(): void {
    this.unlockBodyScroll();
    window.removeEventListener('scroll', this.closeApprovalOnScroll, true);
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

  // ---- Intakes modal ----

  openIntakes(release: TechGovernanceRelease): void {
    this.intakesModalRelease.set(release);
    this.intakeFilter.set('all');
    this.intakesEditingId.set(null);
    this.intakeEditBuffer = null;
    this.lockBodyScroll();
  }

  closeIntakes(): void {
    this.closeApproval();
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

  // ---- Tech Governance status ----

  /** Badge text for one intake's PR gate status (computed by the backend, same as the ADO PR check). */
  statusView(intake: TechGovernanceReleaseIntake): StatusView {
    const gate = intake.gateStatus;
    const discussed = formatShortDate(intake.discussedOn);
    switch (gate?.state) {
      case 'approved':
        return {
          tone: 'approved',
          label: `Approved · ${discussed}`,
          detail: intake.approvedBy ? `by ${intake.approvedBy}` : 'from Confluence page',
        };
      // Both are "not discussed yet"; the detail line says whether the team's PRs still pass the ADO check
      case 'grace':
        return { tone: 'grace', label: 'Pending', detail: `PRs allowed until ${formatShortDate(gate.graceEndsOn)}` };
      case 'blocking':
        return {
          tone: 'blocking',
          label: 'Pending',
          detail: gate.graceEndsOn ? `PRs blocked since ${formatShortDate(nextDay(gate.graceEndsOn))}` : 'PRs blocked',
        };
      case 'veto-allow':
        return {
          tone: 'veto-allow',
          label: 'Always Allow (veto)',
          detail: discussed ? `Discussed ${discussed}` : 'Veto overrides discussion',
        };
      case 'veto-block':
        return { tone: 'veto-block', label: 'Always Block (veto)', detail: 'Veto overrides discussion' };
      default:
        return { tone: 'unknown', label: '—', detail: '' };
    }
  }

  // ---- Approve / revoke ----

  openApproval(action: ApprovalAction, branch: string, intake: TechGovernanceReleaseIntake, event: MouseEvent): void {
    const current = this.approvalTarget();
    if (current?.intake.id === intake.id && current.action === action) {
      this.closeApproval();
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const fitsBelow = rect.bottom + POPOVER_GAP_PX + POPOVER_EST_HEIGHT_PX <= window.innerHeight;
    this.meetingDate = todayIsoDate();
    this.approvalError.set('');
    this.approvalTarget.set({
      action,
      branch,
      intake,
      top: fitsBelow ? rect.bottom + POPOVER_GAP_PX : null,
      bottom: fitsBelow ? null : window.innerHeight - rect.top + POPOVER_GAP_PX,
      right: Math.max(8, window.innerWidth - rect.right),
    });
    window.addEventListener('scroll', this.closeApprovalOnScroll, true);
  }

  closeApproval(): void {
    if (this.approvalSaving()) return;
    this.approvalTarget.set(null);
    window.removeEventListener('scroll', this.closeApprovalOnScroll, true);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.approvalTarget()) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.approval-popover, .approval-trigger')) this.closeApproval();
  }

  @HostListener('document:keydown.escape')
  @HostListener('window:resize')
  onDismissApproval(): void {
    this.closeApproval();
  }

  async confirmApproval(): Promise<void> {
    const target = this.approvalTarget();
    if (!target) return;
    if (target.action === 'approve' && !this.meetingDate) {
      this.approvalError.set('Pick the meeting date');
      return;
    }

    this.approvalSaving.set(true);
    this.approvalError.set('');
    try {
      const res = await this.api.request<{ release: TechGovernanceRelease }>(
        'POST',
        `/api/tech-governance-releases-intake/intakes/${target.action}`,
        {
          branch: target.branch,
          intakeId: target.intake.id,
          ...(target.action === 'approve' ? { date: this.meetingDate } : {}),
          actor: this.currentActor(),
        },
      );
      this.approvalSaving.set(false);
      this.closeApproval();
      this.applyRefreshedRelease(res.release);
      void this.loadAwaiting();
    } catch (err: any) {
      this.approvalError.set(err?.error?.error || `Failed to ${target.action} intake`);
      this.approvalSaving.set(false);
    }
  }

  get approvalPreviewDate(): string {
    return formatShortDate(this.meetingDate);
  }

  private applyRefreshedRelease(release: TechGovernanceRelease): void {
    this.releases.update((list) => list.map((r) => (r.branch === release.branch ? release : r)));
    if (this.intakesModalRelease()?.branch === release.branch) this.intakesModalRelease.set(release);
  }

  private currentActor(): string | undefined {
    const email = this.auth.currentUser()?.email;
    return email ? usernameFromEmail(email) : undefined;
  }

  // ---- Awaiting discussion ----

  async loadAwaiting(): Promise<void> {
    this.awaitingLoading.set(true);
    this.awaitingError.set('');
    try {
      const data = await this.api.request<AwaitingDiscussionItem[]>(
        'GET',
        '/api/tech-governance-releases-intake/awaiting-discussion',
      );
      this.awaitingItems.set(Array.isArray(data) ? data : []);
    } catch (err: any) {
      this.awaitingError.set(err?.error?.error || 'Failed to load intakes awaiting discussion');
    } finally {
      this.awaitingLoading.set(false);
    }
  }

  toggleAwaitingCollapsed(): void {
    const next = !this.awaitingCollapsed();
    this.awaitingCollapsed.set(next);
    try {
      localStorage.setItem(AWAITING_COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable: the panel just won't remember its state
    }
  }

  // ---- Intakes modal filters ----

  intakeFilterCount(filter: IntakeFilter): number {
    const intakes = this.intakesModalRelease()?.intakes ?? [];
    return filter === 'all' ? intakes.length : intakes.filter((i) => this.filterOf(i) === filter).length;
  }

  private filterOf(intake: TechGovernanceReleaseIntake): IntakeFilter | null {
    const state = intake.gateStatus?.state;
    if (!state) return null;
    return state === 'veto-allow' || state === 'veto-block' ? 'veto' : state;
  }

  private compareIntakes(a: TechGovernanceReleaseIntake, b: TechGovernanceReleaseIntake): number {
    const sa = a.gateStatus;
    const sb = b.gateStatus;
    const rankA = sa ? INTAKE_SORT_RANK[sa.state] : Number.MAX_SAFE_INTEGER;
    const rankB = sb ? INTAKE_SORT_RANK[sb.state] : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (sa?.state === 'grace') return (sa.graceDaysLeft ?? 0) - (sb?.graceDaysLeft ?? 0);
    if (sa?.state === 'approved') return (b.discussedOn ?? '').localeCompare(a.discussedOn ?? '');
    return 0;
  }

  trackByBranch = (_: number, r: TechGovernanceRelease) => r.branch;
  trackByIntakeId = (_: number, i: TechGovernanceReleaseIntake) => i.id;

  getIntakeUrl(id: string): string {
    return `${INTAKE_PAGE_BASE_URL}${encodeURIComponent(id)}`;
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
