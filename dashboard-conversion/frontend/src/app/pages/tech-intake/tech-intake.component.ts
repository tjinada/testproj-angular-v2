import { Component, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface FieldChange {
  field: string;           // field key
  label: string;           // human-readable label
  section: string;         // e.g. "General", "CDB UI", "Change Scope"
  oldValue: any;           // null means parent itself didn't change (sub-only)
  newValue: any;           // null means parent itself didn't change (sub-only)
  subChanges?: SubFieldChange[];  // populated when sub-fields also changed
}
export interface SubFieldChange {
  field: string;
  label: string;
  oldValue: any;
  newValue: any;
}
import { FormsModule } from '@angular/forms';
import { IntakeSummaryComponent } from './intake-summary.component';
import { ApiService } from '../../services/api.service';

export type StepId = 'general' | 'scope' | 'details' | 'review';
const STEP_ORDER: StepId[] = ['general', 'scope', 'details', 'review'];
// Releases in these states don't accept new intakes (still listed for Modify)
const CLOSED_RELEASE_STATUSES = ['complete', 'aborted'];
const LINK_PATTERN = /^https?:\/\//i;
// "N/A", "n/a", "NA" — accepted in link fields (placeholders invite it for optional fields)
const NOT_APPLICABLE_PATTERN = /^n\/?a$/i;

export interface SubmitBlocker {
  label: string;
  step: StepId;
  scopeIndex?: number;
  // Fix lives in the identity bar (not a step): open the Feature Name editor
  editFeatureName?: boolean;
}

/** One missing/invalid entry, tied to the top-level field row it belongs to. */
interface FieldIssue {
  row: string;   // top-level field key → field-row-<row>
  text: string;  // full message (banner, Review blockers)
  note: string;  // short note under the row ('' when the field shows its own inline error)
}

@Component({
  selector: 'app-tech-intake',
  standalone: true,
  imports: [CommonModule, FormsModule, IntakeSummaryComponent],
  templateUrl: './tech-intake.component.html',
  styleUrls: [
    './tech-intake.component.scss',
    './tech-intake-form.scss',
    './tech-intake-stepper.scss',
    './tech-intake-history.scss',
    './tech-intake-modal.scss'
  ],
})
export class TechIntakeComponent implements OnInit {
  // Stepper
  currentStep: StepId = 'general';
  // Review-step list of missing/invalid fields that block Submit
  submitBlockers: SubmitBlocker[] = [];
  // Set when Next is clicked on an incomplete step: highlights the missing rows
  showStepErrors = false;

  // Template loaded from backend
  template: any = null;

  // Identity (collected in the Create / Modify modals)
  // All releases, newest first (Modify modal)
  releases: { releaseId: string; title: string; status?: string }[] = [];
  // Releases still accepting intakes, newest first (Create modal)
  openReleases: { releaseId: string; title: string; status?: string }[] = [];
  // Create modal DA team type-to-filter
  teamSearchTerm = '';
  showTeamResults = false;
  // In-app "discard unsaved changes?" confirmation
  showDiscardModal = false;
  private _pendingDiscardAction: (() => void) | null = null;
  daTeams: { name: string; jiraProjects: string[] }[] = [];
  // Full unfiltered list of DA teams (for Create flow)
  allDaTeams: { name: string; jiraProjects: string[] }[] = [];
  selectedRelease = '';
  selectedDATeam = '';
  jiraBoardKey = '';
  jiraBoardLink = '';
  intakeTitle = '';
  intakeTitleSuffix = '';
  titleSuffixLocked = true;
  // User search/typeahead
  userSearchTerm = '';
  userResults: Array<{ accountId: string; displayName: string; email: string }> = [];
  selectedUser: { accountId: string; displayName: string; email: string } | null = null;
  private _userSearchTimeout: any = null;

  // Step 2 (General)
  generalValues: Record<string, any> = {};

  // Step 3 (Scopes)
  selectedScopes: Set<string> = new Set();

  // Step 4 (Scope details)
  scopeValues: Record<string, any> = {};
  dynamicRows: Record<string, any[][]> = {};
  // Scope Details sub-step tracking
  activeScopeIndex = 0;
  // Visited sub-steps by section key (not position), so adding/removing scopes keeps progress
  private visitedScopeKeys = new Set<string>();
  // "Remove scope" confirmation (× on a Scope Details pill)
  scopeToRemove: { key: string; label: string; index: number } | null = null;

  private _visibleScopeSectionsCache: { key: string; section: any }[] | null = null;
  private _lastScopeSnapshot = '';

  // UI state
  isExporting = false;
  exportError: string | null = null;
  exportSuccess: { pageId: string; pageUrl: string } | null = null;
  isLoading = true;
  error: string | null = null;
  // History drawer state (edit mode)
  showHistoryDrawer = false;
  // ─── History drawer resize ────────────────────────────────────────
  drawerWidth = 420; // default px
  isDragging = false; // public for template binding while actively dragging
  private _dragStartX = 0;
  private _dragStartWidth = 0;
  private readonly DRAWER_MIN_WIDTH = 320;
  private readonly DRAWER_MAX_WIDTH = 780;
  // Tooltip popup element (injected to document.body)
  private _tooltipEl: HTMLElement | null = null;
  // Post-export state
  postExportState: 'idle' | 'success' = 'idle';
  // Validation notification
  validationMessage: string | null = null;
  private _validationTimeout: any = null;

  // Change detection (edit mode)
  private _originalFormSnapshot: string | null = null;
  noChangeMessage: string | null = null;

  // --- Create / Edit modal state ---
  showCreateModal = false;
  createForm = { release: '', daTeam: '', titleSuffix: '' };
  createModalError: string | null = null;
  createModalLoading = false;
  createModalExistingIntake: { pageId: string; title: string; url?: string } | null = null;
  createModalChecking = false;
  // Duplicate intake modal state
  createModalState: 'select' | 'results' | 'schema-warning' | null = null;
  previousIntakes: Array<{
    release: string;
    title: string;
    pageId: string;
    url: string;
    lastUpdated: string | null;
    updatedBy: string | null;
  }> = [];
  previousIntakesLoading = false;
  selectedDuplicationSource: { release: string; title: string; pageId: string; url: string } | null = null;
  // Schema drift warning data (populated by Prompt 3 logic)
  schemaDriftWarnings: string[] = [];
  duplicationInProgress = false;
  showEditModal = false;
  editModalRelease = '';
  editModalPages: Array<{ pageId: string; title: string; url: string; lastUpdated: string | null; updatedBy: string | null }> = [];
  editModalPagesLoading = false;
  editModalSelectedPageId = '';
  editModalLoading = false;
  editMode = false;
  editPageId = '';
  // Edit history loaded from Confluence content property
  editHistory: Array<{
    editedBy: { name: string; email: string; accountId?: string };
    editedAt: string;
    fieldsChanged: FieldChange[];
  }> = [];

  // Intake page(s) for the intake being edited — drives the identity bar "View ↗" link
  editIntakePages: Array<{ pageId: string; title: string; url: string; lastUpdated: string | null; updatedBy: string | null }> = [];
  // Original creator information from the pulled intake (read-only in edit mode)
  originalCreator: { name: string; email: string } | null = null;
  // Whether a create/edit modal has been submitted to open the form
  modalSubmitted = false;

  constructor(private readonly apiService: ApiService) {}

  ngOnInit(): void {
    void this.loadData();
  }

  toggleHistoryDrawer(): void {
    if (this.showHistoryDrawer) {
      this.closeHistoryDrawer();
    } else {
      this.showHistoryDrawer = true;
    }
  }

  closeHistoryDrawer(): void {
    this.showHistoryDrawer = false;
    // reset to default width when closed so it reopens consistently
    this.drawerWidth = 420;
    // ensure any injected tooltip is removed when closing
    this.hideTooltip();
  }

  onDrawerDragStart(event: MouseEvent): void {
    this.isDragging = true;
    this._dragStartX = event.clientX;
    this._dragStartWidth = this.drawerWidth;
    event.preventDefault();
    const onMove = (e: MouseEvent) => {
      if (!this.isDragging) return;
      const delta = this._dragStartX - e.clientX;
      this.drawerWidth = Math.min(
        this.DRAWER_MAX_WIDTH,
        Math.max(this.DRAWER_MIN_WIDTH, this._dragStartWidth + delta)
      );
    };
    const onUp = () => {
      this.isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ─── Tooltip popup (injected to body to escape scroll/overflow contexts) ──
  onPillMouseEnter(event: MouseEvent, el: HTMLElement): void {
    const text = el?.getAttribute?.('data-tooltip');
    if (!text) return;
    const rect = el.getBoundingClientRect();
    this.showTooltipFor(el, rect);
  }

  onPillMouseLeave(_event: MouseEvent): void {
    this.hideTooltip();
  }

  showTooltipFor(pill: HTMLElement, rect: DOMRect): void {
    const text = pill.getAttribute('data-tooltip');
    if (!text) return;
    this.hideTooltip(); // remove any existing
    const el = document.createElement('div');
    el.className = 'hc-tooltip-popup';
    el.textContent = text;
    document.body.appendChild(el);
    this._tooltipEl = el;
    // Position above the pill, centered
    requestAnimationFrame(() => {
      const tipRect = el.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      let top = rect.top - tipRect.height - 8;
      // Clamp to viewport
      left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
      if (top < 8) top = rect.bottom + 8; // flip below if no room above
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.opacity = '1';
    });
  }

  hideTooltip(): void {
    if (this._tooltipEl) {
      this._tooltipEl.remove();
      this._tooltipEl = null;
    }
  }

  private clearConditionalSubFields(store: 'general' | 'scope', field: any, selectedValue: string): void {
    const storeRef = store === 'general' ? this.generalValues : this.scopeValues;
    const cond = field.conditionalFields || {};
    const normalizedValue = String(selectedValue || '').toLowerCase();
    const isNo = normalizedValue === 'no';
    // ── Conditionally clear detailField ──────────────────────────
    // Only clear the detail value when switching to an option that hides the
    // details textarea (the last option, unless alwaysShowDetails is set).
    // This prevents "High" risk from wiping details just because it's last.
    if (field.detailField && field.detailField in storeRef) {
      if (field.type === 'yes-no') {
        // yes-no fields: always clear details on change (old behaviour)
        delete storeRef[field.detailField];
      } else if (field.options && field.options.length > 0 && !field.alwaysShowDetails) {
  const lastOption = String(field.options[field.options.length - 1]).toLowerCase();
  if (normalizedValue === lastOption) {
    // Switching TO the last option hides the textarea — clear so stale
    // data doesn't persist invisibly
    delete storeRef[field.detailField];
  }
  // Switching between any non-last options: preserve the detail value
}


    }
    // ── Clear conditional sub-fields based on direction ───────────
    if (isNo) {
      // Switching to No — clear whenNotNo and whenYes sub-fields
      for (const sub of (cond.whenNotNo || [])) {
        if (sub.field) delete storeRef[sub.field];
      }
      for (const sub of (cond.whenYes || [])) {
        if (sub.field) delete storeRef[sub.field];
      }
    } else {
      // Switching away from No — clear whenNo sub-fields
      for (const sub of (cond.whenNo || [])) {
        if (sub.field) delete storeRef[sub.field];
      }
    }
    // ── Fallback: clear implicit detail keys (only when switching to No) ──
    // Some fields store their detail textarea under a key that doesn't
    // match the explicit detailField — try common naming patterns.
    // Only delete if the key actually exists to avoid noise.
    if (isNo) {
      const implicitKeys = [
        `${field.field}Details`,
        `${field.field}Description`,
        `${field.field}_details`,
        `${field.field}_description`,
      ];
      for (const key of implicitKeys) {
        if (key in storeRef) delete storeRef[key];
      }
    }
  }

  exitEditMode(): void {
    const preserveReleases = this.releases;
    const preserveAllDaTeams = this.allDaTeams;
    this.resetForm();
    this.releases = preserveReleases;
    this.allDaTeams = preserveAllDaTeams;
    this.daTeams = this.allDaTeams;
    this.editMode = false;
    this.editPageId = '';
    this.editIntakePages = [];
    this.originalCreator = null;
    this.currentStep = 'general';
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    try {
      const [releases, daTeamsData, template] = await Promise.all([
        this.apiService.request<any[]>('GET', '/api/tech-intake/releases'),
        this.apiService.request<Record<string, any>>('GET', '/api/tech-intake/da-teams'),
        this.apiService.request<any>('GET', '/api/tech-intake/intake-template'),
      ]);

      this.releases = (releases || [])
        .map((r) => ({ releaseId: r.releaseId, title: r.title, status: r.status }))
        .sort((a, b) => TechIntakeComponent.compareReleaseIdsDesc(a.releaseId, b.releaseId));
      this.openReleases = this.releases.filter((r) => !CLOSED_RELEASE_STATUSES.includes(r.status || ''));
      // Keep an unfiltered master list for Create flow and initialize visible list
      this.allDaTeams = Object.values(daTeamsData || {})
        .map((t: any) => ({ name: t.name, jiraProjects: t.jiraProjects || [] }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
      this.daTeams = this.allDaTeams;
      this.template = template;
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Failed to load data';
    } finally {
      this.isLoading = false;
    }
  }

  // ─── Release / DA team pick lists ─────────────────────────────────
  /** Version-aware, newest first: R97, R95, R92.2, R92.1, R92.0.5, R92.0.1, R92 */
  private static compareReleaseIdsDesc(a: string, b: string): number {
    const parse = (id: string) => String(id || '').replace(/^r/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  /** "R94 — CIAM R3.2 Release" instead of "R94 — R94 - CIAM R3.2 Release" */
  releaseLabel(r: { releaseId: string; title: string }): string {
    const id = r.releaseId || '';
    const title = (r.title || '').trim();
    if (!title || title === id) return id;
    const rest = title.slice(id.length);
    const repeatsId = title.toLowerCase().startsWith(id.toLowerCase()) && /^(\s|-|—|:|$)/.test(rest);
    const display = repeatsId ? rest.replace(/^[\s\-—:]+/, '') : title;
    return display ? `${id} — ${display}` : id;
  }

  filteredDaTeams(): { name: string; jiraProjects: string[] }[] {
    const term = this.teamSearchTerm.trim().toLowerCase();
    if (!term || term === this.createForm.daTeam.toLowerCase()) return this.allDaTeams;
    return this.allDaTeams.filter((t) => t.name.toLowerCase().includes(term));
  }

  onTeamSearchChange(term: string): void {
    this.teamSearchTerm = term;
    this.showTeamResults = true;
    if (this.createForm.daTeam && term !== this.createForm.daTeam) {
      this.createForm.daTeam = '';
      void this.onCreateModalSelectionChange();
    }
  }

  selectTeam(team: { name: string }): void {
    this.createForm.daTeam = team.name;
    this.teamSearchTerm = team.name;
    this.showTeamResults = false;
    void this.onCreateModalSelectionChange();
  }

  /** Board key for the team picked in the Create modal (drives the title prefix preview) */
  get createModalBoardKey(): string {
    return (this.allDaTeams.find((t) => t.name === this.createForm.daTeam)?.jiraProjects?.[0] || '').trim();
  }

  // ─── Unsaved-changes guard ────────────────────────────────────────
  get hasUnsavedChanges(): boolean {
    return this.modalSubmitted && this.postExportState !== 'success' && this.hasFormChanged();
  }

  private runOrConfirmDiscard(action: () => void): void {
    if (!this.hasUnsavedChanges) {
      action();
      return;
    }
    this._pendingDiscardAction = action;
    this.showDiscardModal = true;
  }

  requestCreateModal(): void {
    this.runOrConfirmDiscard(() => this.openCreateModal());
  }

  requestEditModal(): void {
    this.runOrConfirmDiscard(() => this.openEditModal());
  }

  confirmDiscard(): void {
    const action = this._pendingDiscardAction;
    this.cancelDiscard();
    action?.();
  }

  cancelDiscard(): void {
    this.showDiscardModal = false;
    this._pendingDiscardAction = null;
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.hasUnsavedChanges) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  // ─── Form entry ───────────────────────────────────────────────────
  /**
   * Common entry into the wizard after a modal (blank, duplicate or edit).
   * Defaults are applied BEFORE the snapshot so they never show up as user edits.
   */
  private enterForm(): void {
    this.applyFieldDefaults();
    this._originalFormSnapshot = this.getFormStateSnapshot();
    this.titleSuffixLocked = true;
    this.submitBlockers = [];
    this.showStepErrors = false;
    this.validationMessage = null;
    this.modalSubmitted = true;
    this.currentStep = 'general';
  }

  /** Option B: seed YAML `default:` values for any field that has no value yet. */
  private applyFieldDefaults(): void {
    if (!this.template) return;
    const seed = (store: Record<string, any>, fields: any[] = []) => {
      for (const f of fields) {
        if (f.default === undefined || store[f.field] !== undefined) continue;
        store[f.field] = Array.isArray(f.default) ? [...f.default] : f.default;
      }
    };
    seed(this.generalValues, this.template.general?.fields);
    for (const section of Object.values(this.template.scopeDetails || {}) as any[]) {
      seed(this.scopeValues, section.fields);
    }
  }

  openCreateModal(): void {
    this.showCreateModal = true;
    this.createModalState = 'select';
    this.createForm = { release: '', daTeam: '', titleSuffix: '' };
    this.teamSearchTerm = '';
    this.showTeamResults = false;
    this.createModalError = null;
    this.createModalLoading = false;
    this.createModalExistingIntake = null;
    this.createModalChecking = false;
    this.previousIntakes = [];
    this.previousIntakesLoading = false;
    this.selectedDuplicationSource = null;
    this.schemaDriftWarnings = [];
    this.duplicationInProgress = false;
  }

  closeCreateModal(): void {
    this.showCreateModal = false;
    this.createModalState = null;
  }

  async onCreateModalSelectionChange(): Promise<void> {
    // Reset modal-specific state
    this.createModalExistingIntake = null;
    this.createModalError = null;
    this.previousIntakes = [];
    this.selectedDuplicationSource = null;
    this.createModalState = 'select';
    if (!this.createForm.release || !this.createForm.daTeam) return;
    this.createModalChecking = true;
    try {
      // Resolve board key for this DA team (if available)
      const team = this.allDaTeams.find(t => t.name === this.createForm.daTeam);
      const boardKey = (team?.jiraProjects?.[0] || '').trim();

      // Step 1: Check if an intake already exists for this release+team
      const lookupUrl = boardKey
        ? `/api/tech-intake/intake/lookup?release=${encodeURIComponent(this.createForm.release)}&boardKey=${encodeURIComponent(boardKey)}`
        : `/api/tech-intake/intake/lookup?release=${encodeURIComponent(this.createForm.release)}&daTeam=${encodeURIComponent(this.createForm.daTeam)}`;

      const data = await this.apiService.request<any>('GET', lookupUrl);
      const results = data.results || [];
      if (results.length > 0) {
        // Intake already exists — show inline message
        this.createModalExistingIntake = { pageId: results[0].pageId, title: results[0].title || '', url: results[0].url || '' };
        this.createModalState = 'select';
        return;
      }

      // Step 2: No existing intake — fetch previous intakes for this DA team
      if (boardKey) {
        this.previousIntakesLoading = true;
        this.createModalState = 'results';
        try {
          const teamData = await this.apiService.request<any>('GET', `/api/tech-intake/intakes-by-team/${encodeURIComponent(boardKey)}`);
          this.previousIntakes = teamData.intakes || [];
        } catch (err) {
          console.error('Failed to fetch previous intakes:', err);
          this.previousIntakes = [];
        } finally {
          this.previousIntakesLoading = false;
        }
      } else {
        // No board key available — show results state with empty table
        this.createModalState = 'results';
      }
    } catch (err) {
      console.error('Create modal lookup failed:', err);
      this.createModalError = 'Failed to check for existing intakes.';
    } finally {
      this.createModalChecking = false;
    }
  }

  async submitCreateModal(): Promise<void> {
    if (!this.createForm.release || !this.createForm.daTeam || !this.selectedUser) return;
    // New intakes (blank or duplicate) need a Feature Name; redirect-to-edit doesn't
    if (!this.createModalExistingIntake && !this.createForm.titleSuffix.trim()) return;
    // Case 1: Existing intake — redirect to edit
    if (this.createModalExistingIntake) {
      this.createModalLoading = true;
      this.createModalError = null;
      try {
        const pageId = this.createModalExistingIntake.pageId;
        const pulled = await this.apiService.request<any>('GET', `/api/tech-intake/intake/${pageId}/pull`);
        const formData = pulled.formData || pulled;
        const preserveReleases = this.releases;
        const preserveAllDaTeams = this.allDaTeams;
        this.resetForm();
        this.releases = preserveReleases;
        this.allDaTeams = preserveAllDaTeams;
        this.daTeams = this.allDaTeams;
        this.populateFormFromData(formData);
        if (pulled.createdBy) {
          this.originalCreator = { name: pulled.createdBy.name || pulled.exportedBy || 'unknown', email: pulled.createdBy.email || '' };
        }
        this.editHistory = pulled.editHistory || [];
        this.editMode = true;
        this.editPageId = pageId;
        // Lets the identity bar show the "View ↗" link for this page
        this.editIntakePages = [{ pageId, title: this.createModalExistingIntake?.title || '', url: this.createModalExistingIntake?.url || '', lastUpdated: null, updatedBy: null }];
        this.closeCreateModal();
        this.enterForm();
      } catch (err) {
        console.error('Create modal submit failed:', err);
        this.createModalError = 'Something went wrong. Please try again.';
      } finally {
        this.createModalLoading = false;
      }
      return;
    }
    // Case 2: Duplicate from a previous intake
    if (this.selectedDuplicationSource) {
      await this.beginDuplication();
      return;
    }
    // Case 3: Create brand new (blank) intake
    this.createModalLoading = true;
    this.createModalError = null;
    try {
      const preserveReleases = this.releases;
      const preserveAllDaTeams = this.allDaTeams;
      this.resetForm();
      this.releases = preserveReleases;
      this.allDaTeams = preserveAllDaTeams;
      this.daTeams = this.allDaTeams;
      this.editMode = false;
      this.editPageId = '';
      this.selectedRelease = this.createForm.release;
      this.selectedDATeam = this.createForm.daTeam;
      this.onDATeamChange();
      this.intakeTitleSuffix = this.createForm.titleSuffix.trim();
      this.closeCreateModal();
      this.enterForm();
    } catch (err) {
      console.error('Create modal submit failed:', err);
      this.createModalError = 'Something went wrong. Please try again.';
    } finally {
      this.createModalLoading = false;
    }
  }

  /** null = "Blank intake" row (the default). Plain radio semantics — no click-to-deselect. */
  selectDuplicationSource(intake: { release: string; title: string; pageId: string; url: string } | null): void {
    this.selectedDuplicationSource = intake;
  }

  // Temporary storage for fetched source data when showing schema-warning
  private _pendingDuplicationData: any = null;

  /**
   * Fetch source intake data, detect schema drift (stub), and either show
   * a warning or apply duplication.
   */
  async beginDuplication(): Promise<void> {
    if (!this.selectedDuplicationSource) return;
    this.duplicationInProgress = true;
    this.createModalError = null;
    try {
      const sourcePageId = this.selectedDuplicationSource.pageId;
      const pulled = await this.apiService.request<any>('GET', `/api/tech-intake/intake/${sourcePageId}/pull`);
      const sourceFormData = pulled.formData || pulled;
      // Store for proceedDespiteDrift
      this._pendingDuplicationData = sourceFormData;
      // Schema drift detection
      const unmappedFields = this.detectSchemaDrift(sourceFormData);
      const newRequiredFields = this.getNewTemplateFields(sourceFormData);
      // Combine warnings
      const allWarnings: string[] = [];
      if (unmappedFields.length > 0) {
        allWarnings.push('── Fields that will be SKIPPED (no longer in template) ──');
        allWarnings.push(...unmappedFields);
      }
      if (newRequiredFields.length > 0) {
        if (allWarnings.length > 0) allWarnings.push(''); // spacer
        allWarnings.push('── Fields that will be BLANK (new in current template) ──');
        allWarnings.push(...newRequiredFields);
      }
      if (allWarnings.length > 0) {
        this.schemaDriftWarnings = allWarnings;
        this.createModalState = 'schema-warning';
        return;
      }
      // No drift — proceed directly
      this.applyDuplication(sourceFormData);
    } catch (err) {
      console.error('Duplication failed:', err);
      this.createModalError = 'Failed to load source intake data.';
    } finally {
      this.duplicationInProgress = false;
    }
  }

  /**
   * Detect fields in sourceFormData that don't exist in current template.
   * Stub: return empty array for now; full logic will be added in Prompt 3.
   */
  private getTemplateFieldKeys(): {
    knownGeneralKeys: Set<string>;
    knownScopeKeys: Set<string>;
    knownScopeIds: Set<string>;
    generalFieldLabels: Map<string, string>;
    scopeFieldLabels: Map<string, string>;
  } {
    const knownGeneralKeys = new Set<string>();
    const knownScopeKeys = new Set<string>();
    const generalFieldLabels = new Map<string, string>();
    const scopeFieldLabels = new Map<string, string>();
    for (const f of (this.template.general?.fields || [])) {
      knownGeneralKeys.add(f.field);
      generalFieldLabels.set(f.field, f.label || f.field);
      if (f.detailField) {
        knownGeneralKeys.add(f.detailField);
        generalFieldLabels.set(f.detailField, `${f.label || f.field} (details)`);
      }
      if (f.type === 'radio-with-link' || (Array.isArray(f.options) && f.options.some((o: any) => o.hasLink))) {
        knownGeneralKeys.add(`${f.field}_link`);
        generalFieldLabels.set(`${f.field}_link`, `${f.label || f.field} (link)`);
      }
      const cond = f.conditionalFields || {};
      for (const sub of [...(cond.whenYes || []), ...(cond.whenNo || []), ...(cond.whenNotNo || [])]) {
        if (sub.field) {
          knownGeneralKeys.add(sub.field);
          generalFieldLabels.set(sub.field, sub.label || sub.field);
        }
      }
    }
    for (const [_key, section] of Object.entries(this.template.scopeDetails || {})) {
      const sec = section as any;
      for (const f of (sec.fields || [])) {
        knownScopeKeys.add(f.field);
        scopeFieldLabels.set(f.field, f.label || f.field);
        if (f.detailField) knownScopeKeys.add(f.detailField);
        if (f.type === 'radio-with-link' || (Array.isArray(f.options) && f.options.some((o: any) => o.hasLink))) {
          knownScopeKeys.add(`${f.field}_link`);
          scopeFieldLabels.set(`${f.field}_link`, `${f.label || f.field} (link)`);
        }
        const cond = f.conditionalFields || {};
        for (const sub of [...(cond.whenYes || []), ...(cond.whenNo || []), ...(cond.whenNotNo || [])]) {
          if (sub.field) {
            knownScopeKeys.add(sub.field);
            scopeFieldLabels.set(sub.field, sub.label || sub.field);
          }
        }
      }
    }
    const knownScopeIds = new Set<string>((this.template.step2?.scopes || []).map((s: any) => s.id));
    return { knownGeneralKeys, knownScopeKeys, knownScopeIds, generalFieldLabels, scopeFieldLabels };
  }

  detectSchemaDrift(sourceFormData: any): string[] {
    if (!this.template || !sourceFormData) return [];
    const unmapped: string[] = [];
    const { generalValues: sourceGeneral, selectedScopes: sourceSelectedScopes, scopeValues: sourceScopeValues, dynamicRows: sourceDynamicRows } = this.normalizeSourceFormData(sourceFormData);
    const { knownGeneralKeys, knownScopeKeys, knownScopeIds, generalFieldLabels, scopeFieldLabels } = this.getTemplateFieldKeys();
    // ── 2. Check source generalValues against known general keys ───────
    for (const key of Object.keys(sourceGeneral || {})) {
      if (!knownGeneralKeys.has(key)) {
        const label = generalFieldLabels.get(key) || key;
        unmapped.push(`General: ${label}`);
      }
    }
    // ── 3. Check source scopeValues against known scope keys ───────────
    for (const key of Object.keys(sourceScopeValues || {})) {
      if (!knownScopeKeys.has(key)) {
        const label = scopeFieldLabels.get(key) || key;
        unmapped.push(`Scope: ${label}`);
      }
    }
    // ── 4. Check source dynamicRows against known scope keys ───────────
    for (const key of Object.keys(sourceDynamicRows || {})) {
      if (!knownScopeKeys.has(key)) {
        const label = scopeFieldLabels.get(key) || key;
        unmapped.push(`Scope (table): ${label}`);
      }
    }
    // ── 5. Check source selectedScopes against known scope IDs ─────────
    for (const scopeId of sourceSelectedScopes || []) {
      if (!knownScopeIds.has(scopeId)) {
        // Try to find a human label from source context
        unmapped.push(`Scope section: ${scopeId}`);
      }
    }
    return unmapped;
  }

  /**
   * Identify fields in the current template that don't exist in the source formData.
   * These are new fields added since the source intake was created — they'll use default values.
   */
  getNewTemplateFields(sourceFormData: any): string[] {
    if (!this.template || !sourceFormData) return [];
    const newFields: string[] = [];
    const { generalValues: sourceGeneral, selectedScopes: sourceSelectedScopes, scopeValues: sourceScopeValues, dynamicRows: sourceDynamicRows } = this.normalizeSourceFormData(sourceFormData);
    const sourceGeneralKeys = new Set(Object.keys(sourceGeneral || {}));
    const sourceScopeKeys = new Set([
      ...Object.keys(sourceScopeValues || {}),
      ...Object.keys(sourceDynamicRows || {}),
    ]);
    // Use template keys helper
    const { knownGeneralKeys, knownScopeKeys } = this.getTemplateFieldKeys();
    // Check general fields
    for (const f of (this.template.general?.fields || [])) {
      if (f.required && !sourceGeneralKeys.has(f.field)) {
        newFields.push(`General: ${f.label || f.field} (required — will be blank)`);
      }
    }
    // Check scope fields (only for scopes the source had selected)
    const sourceScopes = new Set(sourceSelectedScopes || []);
    for (const [_key, section] of Object.entries(this.template.scopeDetails || {})) {
      const sec = section as any;
      if (!sourceScopes.has(sec.showWhen)) continue; // Only check scopes the source used
      for (const f of (sec.fields || [])) {
        if (f.required && !sourceScopeKeys.has(f.field)) {
          newFields.push(`${sec.label || 'Scope'}: ${f.label || f.field} (required — will be blank)`);
        }
      }
    }
    return newFields;
  }

  /**
   * Apply duplicated data to the form and switch to create flow.
   */
  applyDuplication(sourceFormData: any): void {
    // Capture target release/team BEFORE clearing the form
    const targetRelease = this.createForm.release;
    const targetDATeam = this.createForm.daTeam;

    const preserveReleases = this.releases;
    const preserveAllDaTeams = this.allDaTeams;
    // ── Strip deprecated fields from source before populating ──────────
    const cleanedFormData = this.cleanSourceFormData(sourceFormData);
    this.resetForm();
    this.releases = preserveReleases;
    this.allDaTeams = preserveAllDaTeams;
    this.daTeams = this.allDaTeams;
    // Populate form from cleaned source data
    this.populateFormFromData(cleanedFormData);
    // Override identity fields with TARGET release/team
    this.selectedRelease = targetRelease;
    this.selectedDATeam = targetDATeam;
    this.onDATeamChange();
    this.intakeTitleSuffix = this.createForm.titleSuffix.trim();
    this.editMode = false;
    this.editPageId = '';
    this.originalCreator = null;
    this._pendingDuplicationData = null;
    this.closeCreateModal();
    this.enterForm();
  }

  proceedDespiteDrift(): void {
    if (this._pendingDuplicationData) {
      this.applyDuplication(this._pendingDuplicationData);
      this._pendingDuplicationData = null;
    }
  }

  cancelDrift(): void {
    this.schemaDriftWarnings = [];
    this._pendingDuplicationData = null;
    this.createModalState = 'results';
  }

  openEditModal(): void {
    this.showEditModal = true;
    this.editModalRelease = '';
    this.editModalPages = [];
    this.editModalPagesLoading = false;
    this.editModalSelectedPageId = '';
    this.editModalLoading = false;
  }

  closeEditModal(): void {
    this.showEditModal = false;
  }

  async onEditModalReleaseChange(): Promise<void> {
    this.editModalPages = [];
    this.editModalSelectedPageId = '';
    if (!this.editModalRelease) return;
    this.editModalPagesLoading = true;
    try {
      const data = await this.apiService.request<any>(
        'GET',
        `/api/tech-intake/intake/lookup?release=${encodeURIComponent(this.editModalRelease)}`
      );
      this.editModalPages = data.results || [];
    } catch (err) {
      console.error('Failed to load intakes for edit modal:', err);
    } finally {
      this.editModalPagesLoading = false;
    }
  }

  async submitEditModal(): Promise<void> {
    if (!this.editModalSelectedPageId || !this.selectedUser) return;
    this.editModalLoading = true;
    try {
      const data = await this.apiService.request<any>('GET', `/api/tech-intake/intake/${this.editModalSelectedPageId}/pull`);
      const formData = data.formData || data;
      const preserveReleases = this.releases;
      const preserveAllDaTeams = this.allDaTeams;
      this.resetForm();
      this.releases = preserveReleases;
      this.allDaTeams = preserveAllDaTeams;
      this.daTeams = this.allDaTeams;
      this.populateFormFromData(formData);
      if (data.createdBy) {
        this.originalCreator = { name: data.createdBy.name || data.exportedBy || 'unknown', email: data.createdBy.email || '' };
      }
      this.editHistory = data.editHistory || [];
      this.editMode = true;
      this.editPageId = this.editModalSelectedPageId;
      this.editIntakePages = this.editModalPages;
      this.closeEditModal();
      this.enterForm();
    } catch (err) {
      console.error('Failed to load intake for editing:', err);
      alert('Failed to load intake data.');
    } finally {
      this.editModalLoading = false;
    }
  }

  get editingPageTitle(): string {
    return this.editIntakePages.find(p => p.pageId === this.editPageId)?.title || this.intakeTitle || '';
  }

  get editingPageUrl(): string {
    return this.editIntakePages.find(p => p.pageId === this.editPageId)?.url || '';
  }

  /**
   * Enter edit mode for the intake that was just created without clearing form values.
   * This is used by the success-screen "Edit This Intake" action.
   */
  editCurrentIntake(): void {
    if (!this.exportSuccess?.pageId) return;
    this.editMode = true;
    this.editPageId = this.exportSuccess.pageId;
    this.editIntakePages = [{ pageId: this.exportSuccess.pageId, title: '', url: this.exportSuccess.pageUrl, lastUpdated: null, updatedBy: null }];
    this.originalCreator = this.selectedUser ? { name: this.selectedUser.displayName, email: this.selectedUser.email } : null;
    this.postExportState = 'idle';
    this.exportError = null;
    // What was just published is the new baseline for change detection
    this._originalFormSnapshot = this.getFormStateSnapshot();
    this.goToStep('general');
  }

  /** "<release> - <boardKey>" — the fixed part of the Confluence page title */
  get pageTitlePrefix(): string {
    return [this.selectedRelease, this.jiraBoardKey].filter(Boolean).join(' - ');
  }

  // ─── Feature Name (the page-title suffix) ─────────────────────────
  // Required for new intakes only; existing intakes may predate the rule.
  get isFeatureNameMissing(): boolean {
    return !this.editMode && !(this.intakeTitleSuffix || '').trim();
  }

  /** Keep the Review blocker list in sync while the name is edited in the identity bar */
  onFeatureNameChange(): void {
    if (this.currentStep === 'review') this.submitBlockers = this.computeSubmitBlockers();
  }

  // Typeahead: query Jira users via backend proxy
  onUserSearchTermChange(term: string): void {
    this.userSearchTerm = term;
    this.selectedUser = null;
    if (this._userSearchTimeout) clearTimeout(this._userSearchTimeout);
    if (!term || term.trim().length < 3) {
      this.userResults = [];
      return;
    }
    this._userSearchTimeout = setTimeout(async () => {
      try {
        const data = await this.apiService.request<any[]>('GET', `/api/tech-intake/users/search?q=${encodeURIComponent(term)}`);
        this.userResults = (data || []).slice(0, 8).map((u: any) => ({ accountId: u.accountId || '', displayName: u.displayName || '', email: u.email || '' }));
      } catch (err) {
        console.error('User search failed', err);
        this.userResults = [];
      }
    }, 300);
  }

  selectUser(u: { accountId: string; displayName: string; email: string }): void {
    this.selectedUser = u;
    this.userSearchTerm = u.displayName || u.email || '';
    this.userResults = [];
  }

  populateFormFromData(formData: any): void {
    // Map stored formData back into the component's form state
    if (!formData) return;
    // step1 may contain release/daTeam/jiraBoardKey/intakeTitle
    if (formData.step1) {
      const s1 = formData.step1;
      this.selectedRelease = s1.release || s1.releaseId || this.selectedRelease;
      this.selectedDATeam = s1.daTeam || s1.team || this.selectedDATeam;
      // Normalize jiraBoardKey: accept either a raw key (CCBT1) or a URL
      const rawJira = s1.jiraBoardKey || s1.jira || this.jiraBoardKey || '';
      if (rawJira) {
        const m = String(rawJira).trim().match(/([A-Z0-9]+)\/?$/i);
        this.jiraBoardKey = m ? m[1] : String(rawJira).trim();
        // Build a clickable link for UI
        this.jiraBoardLink = `https://bmo.atlassian.net/browse/${this.jiraBoardKey}`;
      }
      const fullTitle = s1.intakeTitle || s1.title || '';
      if (fullTitle) {
        const prefix = `${this.selectedRelease} - ${this.jiraBoardKey}`;
        const prefixWithDash = `${prefix} - `;   // ← space BEFORE and AFTER the dash
        if (this.jiraBoardKey && fullTitle.startsWith(prefixWithDash)) {
          // Full title stored — extract suffix
          this.intakeTitleSuffix = fullTitle.slice(prefixWithDash.length);
          this.intakeTitle = prefix;
        } else if (this.jiraBoardKey && fullTitle === prefix) {
          // No suffix
          this.intakeTitleSuffix = '';
          this.intakeTitle = prefix;
        } else if (this.jiraBoardKey && !fullTitle.includes(' - ')) {
          // Only the suffix was stored (legacy export behaviour)
          this.intakeTitleSuffix = fullTitle;
          this.intakeTitle = prefix;
        } else {
          // Fallback: keep full title in intakeTitle
          this.intakeTitle = fullTitle;
          this.intakeTitleSuffix = '';
        }
      } else {
        this.intakeTitleSuffix = '';
      }
    }
    // Capture original creator if present in formData
    if (formData.createdBy || formData.metadata?.createdBy) {
      const creator = formData.createdBy || { name: formData.metadata?.createdBy || 'unknown', email: '' };
      this.originalCreator = {
        name: typeof creator === 'string' ? creator : (creator.name || creator.displayName || 'unknown'),
        email: typeof creator === 'object' ? (creator.email || '') : '',
      };
    }
    // selected scopes
    if (formData.step2 && Array.isArray(formData.step2.scopes)) {
      this.selectedScopes = new Set(formData.step2.scopes || []);
    } else if (formData.selectedScopes && Array.isArray(formData.selectedScopes)) {
      this.selectedScopes = new Set(formData.selectedScopes || []);
    }
    // general values and scope values
    if (formData.step3 && formData.step3.general) {
      this.generalValues = { ...formData.step3.general };
      // Normalize any display-formatted dates back to ISO for the date picker
      this.normalizeDateFieldsInStore(this.generalValues, this.template?.general?.fields || []);
    } else if (formData.generalValues) {
      this.generalValues = { ...formData.generalValues };
      this.normalizeDateFieldsInStore(this.generalValues, this.template?.general?.fields || []);
    }
    if (formData.step3) {
      const sv = { ...formData.step3 };
      delete sv.general;
      this.scopeValues = { ...(sv || {}) };
      // Normalize date fields in scope values if any
      const allScopeFields = Object.values(this.template?.scopeDetails || {}).flatMap((s: any) => s.fields || []);
      this.normalizeDateFieldsInStore(this.scopeValues, allScopeFields || []);
      // Backwards compatibility: map old generic keys to new description keys if present
      if (!this.scopeValues['channelsDescription'] && this.scopeValues['channelsDetails']) {
        this.scopeValues['channelsDescription'] = this.scopeValues['channelsDetails'];
      }
      if (!this.scopeValues['awsLambdaDescription'] && this.scopeValues['awsLambdaDetails']) {
        this.scopeValues['awsLambdaDescription'] = this.scopeValues['awsLambdaDetails'];
      }
    } else if (formData.scopeValues) {
      this.scopeValues = { ...formData.scopeValues };
      const allScopeFields = Object.values(this.template?.scopeDetails || {}).flatMap((s: any) => s.fields || []);
      this.normalizeDateFieldsInStore(this.scopeValues, allScopeFields || []);
    }
    if (formData.dynamicRows) {
      this.dynamicRows = { ...formData.dynamicRows };
    }
    // Title suffix should be locked when loading existing data
    this.titleSuffixLocked = true;
  }

  unlockTitleSuffix(): void {
    this.titleSuffixLocked = false;
  }

  startNewIntake(): void {
    this.resetForm();
    this.editMode = false;
    this.editPageId = '';
    this.editIntakePages = [];
    this.originalCreator = null;
    this.exportSuccess = null;
    this.exportError = null;
    this.postExportState = 'idle';
    this.currentStep = 'general';
  }

  resetForm(): void {
    this.selectedRelease = '';
    this.selectedDATeam = '';
    this.jiraBoardKey = '';
    this.intakeTitle = '';
    this.intakeTitleSuffix = '';
    // selectedUser / userSearchTerm are intentionally kept: same person for the whole session
    this.userResults = [];
    this.originalCreator = null;
    this.generalValues = {};
    this.selectedScopes = new Set();
    this.scopeValues = {};
    this.dynamicRows = {};
    this._originalFormSnapshot = null;
    this.submitBlockers = [];
    this.currentStep = 'general';
    this.activeScopeIndex = 0;
    this.visitedScopeKeys = new Set();
    this.scopeToRemove = null;
    this.exportSuccess = null;
    this.exportError = null;
    this.postExportState = 'idle';
    this.editHistory = [];
    this.closeHistoryDrawer();
    this.modalSubmitted = false;
    // Duplication modal state resets
    this.previousIntakes = [];
    this.previousIntakesLoading = false;
    this.selectedDuplicationSource = null;
    this.schemaDriftWarnings = [];
    this.duplicationInProgress = false;
    this._pendingDuplicationData = null;
    this.createModalState = null;
    this.titleSuffixLocked = true;
  }

  onDATeamChange(): void {
    const team = this.daTeams.find((t) => t.name === this.selectedDATeam);
    if (team && team.jiraProjects && team.jiraProjects.length > 0) {
      // jiraBoardKey should be the project key (e.g. CCBT1)
      this.jiraBoardKey = team.jiraProjects[0];
      this.jiraBoardLink = `https://bmo.atlassian.net/browse/${this.jiraBoardKey}`;
    } else {
      this.jiraBoardKey = '';
      this.jiraBoardLink = '';
    }
    // Title prefix/suffix is handled separately; preserve any user-entered suffix.
  }

  goToStep(step: StepId): void {
    if (step === this.currentStep) return;
    const movingForward = STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(this.currentStep);
    // Create mode gates forward moves on the current step; edit mode navigates freely
    // (Submit is still blocked by submitBlockers in both modes)
    if (movingForward && !this.editMode && !this.canProceedFromStep(this.currentStep)) return;
    this.currentStep = step;
    this.showStepErrors = false; // a fresh step starts without red rows
    // Navigating away from the review/submit step should clear any export state
    if (step !== 'review') {
      this.exportError = null;
      this.exportSuccess = null;
      this.postExportState = 'idle';
    }
    if (step === 'details') {
      const visible = this.getVisibleScopeSections();
      if (this.editMode) {
        visible.forEach((s) => this.visitedScopeKeys.add(s.key)); // edit mode: every sub-step open
      }
      if (movingForward) {
        // Land on the first sub-step not visited yet (a newly added scope), else the first one
        const firstUnvisited = visible.findIndex((s) => !this.visitedScopeKeys.has(s.key));
        this.activeScopeIndex = firstUnvisited >= 0 ? firstUnvisited : 0;
      }
      this.clampActiveScope();
      this.markActiveScopeVisited();
    }
    if (step === 'review') {
      this.submitBlockers = this.computeSubmitBlockers();
    }
  }

  // ─── Stepper ──────────────────────────────────────────────────────
  readonly stepList: { id: StepId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'scope', label: 'Change Scope' },
    { id: 'details', label: 'Scope Details' },
    { id: 'review', label: 'Review & Submit' },
  ];

  stepStatus(step: StepId): 'done' | 'current' | 'upcoming' {
    const diff = STEP_ORDER.indexOf(step) - STEP_ORDER.indexOf(this.currentStep);
    return diff < 0 ? 'done' : diff === 0 ? 'current' : 'upcoming';
  }

  /**
   * Stepper click. Back (or anywhere in edit mode): go there.
   * Forward in create mode: behaves like Next — one step on, or show what's missing.
   */
  onStepClick(step: StepId): void {
    const target = STEP_ORDER.indexOf(step);
    const current = STEP_ORDER.indexOf(this.currentStep);
    if (this.editMode || target <= current) {
      this.goToStep(step);
      return;
    }
    if (this.currentStep === 'details' && this.activeScopeIndex < this.getVisibleScopeSections().length - 1) {
      this.attemptNextScope(); // finish the remaining scope sub-steps first
      return;
    }
    this.attemptNext(STEP_ORDER[current + 1]);
  }

  goToScopeIndex(index: number): void {
    if (!this.canGoToScopeIndex(index)) return;
    this.activeScopeIndex = index;
    this.showStepErrors = false;
  }

  canProceedFromStep(step: StepId): boolean {
    switch (step) {
      case 'general':
        return this.validateGeneralFields();
      case 'scope':
        return this.selectedScopes.size > 0;
      case 'details':
        // Must have visited all scope sub-steps AND pass current scope field validation
        return this.hasCompletedAllScopes() && this.validateCurrentScopeFields();
      case 'review':
        return true;
      default:
        return false;
    }
  }

  backToLastScope(): void {
    const visible = this.getVisibleScopeSections();
    this.activeScopeIndex = Math.max(0, (visible || []).length - 1);
    this.markActiveScopeVisited();
    this.currentStep = 'details';
  }

  // Advance to the next visible scope sub-step (used by the Next button inside Scope Details)
  advanceToNextScope(): void {
    const visible = this.getVisibleScopeSections();
    if (this.activeScopeIndex < visible.length - 1) {
      this.activeScopeIndex++;
      this.markActiveScopeVisited();
    }
  }

  // Go back to the previous visible scope sub-step
  goToPreviousScope(): void {
    if (this.activeScopeIndex > 0) {
      this.activeScopeIndex--;
      this.showStepErrors = false;
    }
  }

  private markActiveScopeVisited(): void {
    const entry = this.getVisibleScopeSections()[this.activeScopeIndex];
    if (entry) this.visitedScopeKeys.add(entry.key);
  }

  private clampActiveScope(): void {
    const last = this.getVisibleScopeSections().length - 1;
    this.activeScopeIndex = Math.max(0, Math.min(this.activeScopeIndex, last));
  }

  isScopeVisited(key: string): boolean {
    return this.visitedScopeKeys.has(key);
  }

  // Can the user click the sub-step button for `index`? Visited ones (and the current one) only.
  canGoToScopeIndex(index: number): boolean {
    const entry = this.getVisibleScopeSections()[index];
    return !!entry && (index === this.activeScopeIndex || this.visitedScopeKeys.has(entry.key));
  }

  // Has every selected scope's sub-step been visited at least once?
  hasCompletedAllScopes(): boolean {
    const visible = this.getVisibleScopeSections();
    return visible.length > 0 && visible.every((s) => this.visitedScopeKeys.has(s.key));
  }

  // ─── Remove a scope from Scope Details (× on its pill) ───────────
  requestRemoveScope(entry: { key: string; section: any }, index: number): void {
    if (this.getVisibleScopeSections().length <= 1) return; // at least one scope is required
    this.scopeToRemove = { key: entry.key, label: entry.section?.label || entry.key, index };
  }

  cancelRemoveScope(): void {
    this.scopeToRemove = null;
  }

  /** Untick the scope and clear only its own answers; other scopes and progress are untouched. */
  confirmRemoveScope(): void {
    const target = this.scopeToRemove;
    this.scopeToRemove = null;
    if (!target) return;
    const section = this.template?.scopeDetails?.[target.key];
    if (!section) return;

    this.selectedScopes.delete(section.showWhen);
    for (const f of section.fields || []) {
      delete this.scopeValues[f.field];
      delete this.dynamicRows[f.field];
      if (f.detailField) delete this.scopeValues[f.detailField];
      delete this.scopeValues[`${f.field}_link`];
      for (const sub of Object.values(f.conditionalFields || {}).flat() as any[]) {
        if (sub?.field) delete this.scopeValues[sub.field];
      }
    }
    delete this.scopeValues[`${target.key}_description`]; // free-text fallback for field-less scopes
    this.applyFieldDefaults(); // re-seed "No" defaults so a later re-add starts clean
    this.visitedScopeKeys.delete(target.key);
    this._visibleScopeSectionsCache = null;

    // Stay on the same sub-step: shift back one if an earlier pill was removed;
    // removing the current one shows the next (or the last, via clamp)
    if (target.index < this.activeScopeIndex) this.activeScopeIndex--;
    this.clampActiveScope();
    this.markActiveScopeVisited();
    this.showStepErrors = false;
  }

  // Attempt to advance to a target step, showing validation feedback if blocked
  attemptNext(targetStep: StepId): void {
    // In edit mode, always proceed freely
    if (this.editMode) {
      this.validationMessage = null;
      this.goToStep(targetStep);
      return;
    }
    const currentStep = this.currentStep;
    if (this.canProceedFromStep(currentStep)) {
      this.validationMessage = null;
      this.goToStep(targetStep);
    } else {
      this.showValidationMessage(this.getValidationMessage(currentStep));
      this.revealStepIssues();
    }
  }

  private getValidationMessage(step: StepId): string {
    switch (step) {
      case 'general': {
        const issues = this.getGeneralIssues();
        return issues.length > 0 ? `Please complete: ${issues.join(', ')}` : 'Please fill all required fields marked with *.';
      }
      case 'scope':
        return 'Please select at least one change scope.';
      case 'details': {
        if (!this.hasCompletedAllScopes()) {
          return 'Please navigate through all scope sections before proceeding.';
        }
        const issues = this.getScopeIssues(this.activeScopeIndex);
        return issues.length > 0 ? `Please complete: ${issues.join(', ')}` : 'Please fill all required fields in the current scope section.';
      }
      default:
        return 'Please complete all required fields.';
    }
  }

  // ─── Validation (single rule: YAML `required` / `detailRequired` + currently visible) ───
  private isBlank(value: any): boolean {
    return value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0);
  }

  /** Same visibility rule the template uses for the detail textarea. */
  private isDetailVisible(field: any, value: any): boolean {
    return !!field.hasDetails && !!field.detailField && !!value
      && (!!field.alwaysShowDetails || value !== field.options?.[field.options.length - 1]);
  }

  /** Sub-fields currently shown under a yes-no / conditional-radio parent. */
  private getVisibleSubFields(field: any, value: any): any[] {
    const cond = field.conditionalFields || {};
    if (field.type === 'yes-no') return value === 'Yes' ? cond.whenYes || [] : [];
    if (field.type === 'conditional-radio') {
      if (!value) return [];
      return value === 'No' ? cond.whenNo || [] : cond.whenNotNo || [];
    }
    return [];
  }

  isInvalidLink(value: any): boolean {
    if (this.isBlank(value)) return false;
    const text = String(value).trim();
    return !LINK_PATTERN.test(text) && !NOT_APPLICABLE_PATTERN.test(text);
  }

  private hasFilledRow(fieldName: string): boolean {
    return (this.dynamicRows[fieldName] || []).some((row) =>
      Array.isArray(row) && row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''),
    );
  }

  /**
   * Missing / invalid entries for a set of fields.
   * `row` is the top-level field key (the field-row to highlight), `text` the full message,
   * `note` the short text shown under that row.
   */
  private getFieldIssues(store: 'general' | 'scope', fields: any[] = []): FieldIssue[] {
    const values = store === 'general' ? this.generalValues : this.scopeValues;
    const issues: FieldIssue[] = [];
    const add = (row: string, text: string, note: string) => issues.push({ row, text, note });
    for (const f of fields) {
      const label = f.label || f.field;
      const value = values[f.field];
      if (f.type === 'dynamic-rows') {
        if (!this.hasFilledRow(f.field)) add(f.field, `${label} (at least one row)`, 'Add at least one row');
        continue;
      }
      if (f.required && this.isBlank(value)) add(f.field, label, 'This field is required');
      if (f.type === 'link' && this.isInvalidLink(value)) add(f.field, `${label} (must start with http:// or https://)`, '');
      if (f.type === 'radio-with-link' && this.isInvalidLink(values[`${f.field}_link`])) {
        add(f.field, `${label} link (must start with http:// or https://)`, '');
      }
      if (f.detailRequired && this.isDetailVisible(f, value) && this.isBlank(values[f.detailField])) {
        add(f.field, `${label} — details`, 'Details are required');
      }
      for (const sub of this.getVisibleSubFields(f, value)) {
        if (sub.required && this.isBlank(values[sub.field])) {
          const subLabel = sub.label || 'selection';
          add(f.field, `${label} — ${subLabel}`, `Required: ${subLabel}`);
        }
      }
    }
    return issues;
  }

  // ─── Step-level feedback (red rows + "N required fields left") ────
  /** Issues on the step (or scope sub-step) the user is looking at; create mode only. */
  private getCurrentStepIssues(): FieldIssue[] {
    if (this.editMode) return [];
    if (this.currentStep === 'general') return this.getFieldIssues('general', this.template?.general?.fields);
    if (this.currentStep === 'details') {
      const entry = this.getVisibleScopeSections()[this.activeScopeIndex];
      return entry ? this.getFieldIssues('scope', entry.section?.fields) : [];
    }
    return [];
  }

  /** Count shown next to Next. Counts fields (rows), not individual sub-issues. */
  get remainingFieldCount(): number {
    return new Set(this.getCurrentStepIssues().map((i) => i.row)).size;
  }

  /** Short note under a highlighted row (empty when the row is fine or errors aren't shown yet). */
  rowIssueNote(row: string): string {
    if (!this.showStepErrors) return '';
    return this.getCurrentStepIssues()
      .filter((i) => i.row === row && i.note)
      .map((i) => i.note)
      .join(' · ');
  }

  hasRowIssue(row: string): boolean {
    return this.showStepErrors && this.getCurrentStepIssues().some((i) => i.row === row);
  }

  /** Turn on red rows and bring the first problem into view. */
  revealStepIssues(): void {
    this.showStepErrors = true;
    const first = this.getCurrentStepIssues()[0];
    if (!first) return;
    setTimeout(() => {
      document.getElementById(`field-row-${first.row}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /** Scope Details sub-step Next: advance if valid, otherwise show what's missing. */
  attemptNextScope(): void {
    if (this.editMode || this.validateCurrentScopeFields()) {
      this.showStepErrors = false;
      this.advanceToNextScope();
      return;
    }
    this.showValidationMessage(this.getValidationMessage('details'));
    this.revealStepIssues();
  }

  private showValidationMessage(message: string): void {
    this.validationMessage = message;
    if (this._validationTimeout) clearTimeout(this._validationTimeout);
    this._validationTimeout = setTimeout(() => {
      this.validationMessage = null;
    }, 5000);
  }

  private getGeneralIssues(): string[] {
    return this.getFieldIssues('general', this.template?.general?.fields).map((i) => i.text);
  }

  private getScopeIssues(index: number): string[] {
    const entry = this.getVisibleScopeSections()[index];
    return entry ? this.getFieldIssues('scope', entry.section?.fields).map((i) => i.text) : [];
  }

  validateGeneralFields(): boolean {
    return !!this.template && this.getGeneralIssues().length === 0;
  }

  validateCurrentScopeFields(): boolean {
    const entry = this.getVisibleScopeSections()[this.activeScopeIndex];
    return !!entry && this.getScopeIssues(this.activeScopeIndex).length === 0;
  }

  /** Everything that must be fixed before Submit, with the step to jump to. */
  private computeSubmitBlockers(): SubmitBlocker[] {
    const blockers: SubmitBlocker[] = [];
    // Feature Name is required for new intakes only (existing intakes may predate it)
    if (this.isFeatureNameMissing) {
      blockers.push({ label: 'Feature Name', step: this.currentStep, editFeatureName: true });
    }
    blockers.push(...this.getGeneralIssues()
      .map((label) => ({ label: `General: ${label}`, step: 'general' as StepId })));
    if (this.selectedScopes.size === 0) {
      blockers.push({ label: 'Change Scope: select at least one scope', step: 'scope' });
    }
    this.getVisibleScopeSections().forEach((entry, i) => {
      for (const label of this.getScopeIssues(i)) {
        blockers.push({ label: `${entry.section.label}: ${label}`, step: 'details', scopeIndex: i });
      }
    });
    return blockers;
  }

  goToBlocker(blocker: SubmitBlocker): void {
    if (blocker.editFeatureName) {
      this.titleSuffixLocked = false;
      return;
    }
    this.goToStep(blocker.step);
    if (blocker.scopeIndex !== undefined) {
      this.activeScopeIndex = blocker.scopeIndex;
      this.markActiveScopeVisited();
    }
  }

  /** Change Scope checkbox. Answers and visited progress are kept (re-ticking restores both). */
  toggleScope(scopeId: string): void {
    if (this.selectedScopes.has(scopeId)) this.selectedScopes.delete(scopeId);
    else this.selectedScopes.add(scopeId);
    this._visibleScopeSectionsCache = null; // Invalidate cache
    this.clampActiveScope();
  }

  isScopeSelected(scopeId: string): boolean {
    return this.selectedScopes.has(scopeId);
  }

  getVisibleScopeSections(): { key: string; section: any }[] {
    const snapshot = Array.from(this.selectedScopes).sort().join(',');
    if (this._lastScopeSnapshot === snapshot && this._visibleScopeSectionsCache) {
      return this._visibleScopeSectionsCache;
    }
    this._lastScopeSnapshot = snapshot;
    if (!this.template || !this.template.scopeDetails) return [];
    this._visibleScopeSectionsCache = Object.entries(this.template.scopeDetails)
      .map(([k, v]) => ({ key: k, section: v as any }))
      .filter((s) => this.selectedScopes.has(s.section.showWhen));
    return this._visibleScopeSectionsCache;
  }


  // Field helpers
  getFieldValue(store: 'general' | 'scope', fieldName: string): any {
    return store === 'general' ? this.generalValues[fieldName] : this.scopeValues[fieldName];
  }

  setFieldValue(store: 'general' | 'scope', fieldName: string, value: any): void {
    if (store === 'general') this.generalValues[fieldName] = value;
    else this.scopeValues[fieldName] = value;
    // Clear sub-fields when a yes-no or conditional-radio/radio field changes value
    try {
      const allFields = [
        ...(this.template?.general?.fields || []),
        ...Object.values(this.template?.scopeDetails || {}).flatMap((s: any) => s.fields || []),
      ];
      const fieldDef = allFields.find((f: any) => f.field === fieldName);
      if (fieldDef && (fieldDef.type === 'yes-no' || fieldDef.type === 'conditional-radio' || fieldDef.type === 'radio')) {
        // Always clear sub-fields and detail fields on any value change
        this.clearConditionalSubFields(store, fieldDef, String(value || ''));
      }
    } catch (e) {
      // noop
    }
  }

  toggleCheckboxValue(store: 'general' | 'scope', fieldName: string, option: string): void {
    const storeRef = store === 'general' ? this.generalValues : this.scopeValues;
    const arr = (storeRef[fieldName] = storeRef[fieldName] || []) as string[];
    const idx = arr.indexOf(option);
    if (idx >= 0) {
      arr.splice(idx, 1);
      return;
    }
    // YAML `exclusive:` option (e.g. "Not applicable") can't be combined with the others
    const exclusive = this.findFieldDef(fieldName)?.exclusive;
    if (exclusive) {
      storeRef[fieldName] = option === exclusive ? [option] : [...arr.filter((o) => o !== exclusive), option];
      return;
    }
    arr.push(option);
  }

  /** Top-level field definition (general or any scope section) by key. */
  private findFieldDef(fieldName: string): any {
    const allFields = [
      ...(this.template?.general?.fields || []),
      ...Object.values(this.template?.scopeDetails || {}).flatMap((s: any) => s.fields || []),
    ];
    return allFields.find((f: any) => f.field === fieldName);
  }

  isCheckboxChecked(store: 'general' | 'scope', fieldName: string, option: string): boolean {
    const storeRef = store === 'general' ? this.generalValues : this.scopeValues;
    const arr = storeRef[fieldName] || [];
    return Array.isArray(arr) && arr.indexOf(option) >= 0;
  }

  addDynamicRow(fieldName: string, columnCount: number): void {
    const rows = (this.dynamicRows[fieldName] = this.dynamicRows[fieldName] || []);
    rows.push(new Array(columnCount).fill(''));
  }

  removeDynamicRow(fieldName: string, index: number): void {
    const rows = this.dynamicRows[fieldName] || [];
    rows.splice(index, 1);
  }

  updateDynamicRowCell(fieldName: string, rowIndex: number, colIndex: number, value: string): void {
    const rows = (this.dynamicRows[fieldName] = this.dynamicRows[fieldName] || []);
    rows[rowIndex][colIndex] = value;
  }

  formatDateForDisplay(isoDate: string): string {
    if (!isoDate) return '';
    // Input is YYYY-MM-DD from <input type="date">
    const [year, month, day] = isoDate.split('-').map(Number);
    if (!year || !month || !day) return isoDate;
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    });
    // Output: "July 20, 2026", "May 07, 2026", etc.
  }

  private getFormattedGeneralValues(): Record<string, any> {
    const formatted: Record<string, any> = { ...(this.generalValues || {}) };
    // Format date fields for export (human-readable)
    if (this.template?.general?.fields) {
      for (const f of this.template.general.fields) {
        if (f.type === 'date' && formatted[f.field]) {
          formatted[f.field] = this.formatDateForDisplay(formatted[f.field]);
        }
      }
    }
    return formatted;
  }

  private parseDisplayDateToIso(display: string): string | null {
    if (!display || typeof display !== 'string') return null;
    // If already in ISO YYYY-MM-DD, return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(display)) return display;
    const parsed = new Date(display);
    if (isNaN(parsed.getTime())) return null;
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private normalizeDateFieldsInStore(store: Record<string, any>, fieldDefs: any[]): void {
    if (!store || !fieldDefs) return;
    for (const f of fieldDefs) {
      if (f && f.type === 'date' && store[f.field]) {
        const iso = this.parseDisplayDateToIso(store[f.field]);
        if (iso) store[f.field] = iso;
      }
    }
  }

  /**
   * Remove fields from source formData that don't exist in the current template.
   * Returns a new object (does not mutate the original).
   */
  private cleanSourceFormData(sourceFormData: any): any {
    if (!this.template || !sourceFormData) return sourceFormData;
    const { knownGeneralKeys, knownScopeKeys, knownScopeIds } = this.getTemplateFieldKeys();
    // Normalize source to canonical shape first
    const normalized = this.normalizeSourceFormData(sourceFormData);

    // Build cleaned copy
    const cleaned: any = {
      step1: { ...(sourceFormData.step1 || {}) },
      generalValues: {},
      selectedScopes: [],
      scopeValues: {},
      dynamicRows: {},
    };
    // Copy only known general fields
    for (const [key, val] of Object.entries(normalized.generalValues || {})) {
      if (knownGeneralKeys.has(key)) {
        cleaned.generalValues[key] = val;
      }
    }
    // Copy only known scope selections
    for (const scopeId of (normalized.selectedScopes || [])) {
      if (knownScopeIds.has(scopeId)) {
        cleaned.selectedScopes.push(scopeId);
      }
    }
    // Copy only known scope values
    for (const [key, val] of Object.entries(normalized.scopeValues || {})) {
      if (knownScopeKeys.has(key)) {
        cleaned.scopeValues[key] = val;
      }
    }
    // Copy only known dynamic rows
    for (const [key, val] of Object.entries(normalized.dynamicRows || {})) {
      if (knownScopeKeys.has(key)) {
        cleaned.dynamicRows[key] = val;
      }
    }
    return cleaned;
  }

  private normalizeSourceFormData(sourceFormData: any): {
    generalValues: Record<string, any>;
    selectedScopes: string[];
    scopeValues: Record<string, any>;
    dynamicRows: Record<string, any>;
  } {
    // Safety net: the pull endpoint normalizes old -> new format before returning,
    // but handle the case where raw property data (old or new) reaches the frontend.
    let generalValues: Record<string, any> = {};
    let selectedScopes: string[] = [];
    let scopeValues: Record<string, any> = {};
    let dynamicRows: Record<string, any> = {};
    // General values — old format: step3.general, new format: generalValues
    if (sourceFormData.step3?.general) {
      generalValues = { ...sourceFormData.step3.general };
    } else if (sourceFormData.generalValues) {
      generalValues = { ...sourceFormData.generalValues };
    }
    // Selected scopes — old format: step2.scopes, new format: selectedScopes
    if (Array.isArray(sourceFormData.step2?.scopes)) {
      selectedScopes = [...sourceFormData.step2.scopes];
    } else if (Array.isArray(sourceFormData.selectedScopes)) {
      selectedScopes = [...sourceFormData.selectedScopes];
    }
    // Scope values — old format: everything in step3 except "general", new format: scopeValues
    if (sourceFormData.step3) {
      const sv = { ...sourceFormData.step3 };
      delete sv.general;
      scopeValues = sv;
    } else if (sourceFormData.scopeValues) {
      scopeValues = { ...sourceFormData.scopeValues };
    }
    // Dynamic rows — same key in both formats
    dynamicRows = { ...(sourceFormData.dynamicRows || {}) };
    return { generalValues, selectedScopes, scopeValues, dynamicRows };
  }

  formatSectionHeader(item: string): string {
    return (item || '').replace(/──/g, '').trim();
  }

  // Change-detection helpers
  private getFormStateSnapshot(): string {
    const state = {
      intakeTitleSuffix: this.intakeTitleSuffix || '',
      generalValues: { ...(this.generalValues || {}) },
      selectedScopes: Array.from(this.selectedScopes || []).sort(),
      scopeValues: { ...(this.scopeValues || {}) },
      dynamicRows: { ...(this.dynamicRows || {}) },
    };
    return JSON.stringify(state);
  }

  hasFormChanged(): boolean {
    if (!this._originalFormSnapshot) return true;
    return this.getFormStateSnapshot() !== this._originalFormSnapshot;
  }

  getChangedFields(): FieldChange[] {
    if (!this._originalFormSnapshot || !this.editMode) return [];
    const original = JSON.parse(this._originalFormSnapshot);
    const result: FieldChange[] = [];
    // ── Utility: compare two values ──────────────────────────────
    const isDiff = (a: any, b: any): boolean =>
      JSON.stringify(a ?? '') !== JSON.stringify(b ?? '');
    // ── Utility: collect sub-field changes for a parent ──────────
    const collectSubs = (
      subFieldDefs: any[],
      store: 'general' | 'scope'
    ): SubFieldChange[] => {
      const subs: SubFieldChange[] = [];
      for (const sub of subFieldDefs || []) {
        if (!sub.field) continue;
        const oldVal = store === 'general'
          ? original.generalValues?.[sub.field]
          : original.scopeValues?.[sub.field];
        const newVal = store === 'general'
          ? this.generalValues?.[sub.field]
          : this.scopeValues?.[sub.field];
        if (isDiff(oldVal, newVal)) {
          subs.push({
            field: sub.field,
            label: sub.label || sub.field,
            oldValue: oldVal ?? '—',
            newValue: newVal ?? '—',
          });
        }
      }
      return subs;
    };
    // ── Utility: get ALL sub-field defs from a field def ─────────
    // Covers: conditionalFields.whenYes, whenNo, whenNotNo
    // Also covers detailField (radio hasDetails pattern)
    const getAllSubDefs = (f: any): any[] => {
      const cond = f.conditionalFields || {};
      const subs = [
        ...(cond.whenYes || []),
        ...(cond.whenNo || []),
        ...(cond.whenNotNo || []),
      ];
      // detailField is stored as a sibling key, not a sub-field def —
      // wrap it so collectSubs can handle it uniformly
      if (f.detailField) {
        subs.push({ field: f.detailField, label: 'Details' });
      }
      return subs;
    };
    // ── 1. General fields ─────────────────────────────────────────
    // ── 0. Title suffix ──────────────────────────────────────────
    const originalSuffix = original.intakeTitleSuffix || '';
    const currentSuffix = this.intakeTitleSuffix || '';
    if (originalSuffix !== currentSuffix) {
      result.push({
        field: 'intakeTitleSuffix',
        label: 'Feature Name',
        section: 'General',
        oldValue: originalSuffix || '—',
        newValue: currentSuffix || '—',
      });
    }

    const generalFields: any[] = this.template?.general?.fields || [];
    for (const f of generalFields) {
      const oldVal = original.generalValues?.[f.field];
      const newVal = this.generalValues?.[f.field];
      const parentChanged = isDiff(oldVal, newVal);
      const subChanges = collectSubs(getAllSubDefs(f), 'general');
      if (parentChanged || subChanges.length > 0) {
        result.push({
          field: f.field,
          label: f.label || f.field,
          section: 'General',
          // null signals "parent value itself didn't change, only sub-fields did"
          oldValue: parentChanged ? (oldVal ?? '—') : null,
          newValue: parentChanged ? (newVal ?? '—') : null,
          subChanges: subChanges.length > 0 ? subChanges : undefined,
        });
      }
    }
    // ── 2. Selected scopes ────────────────────────────────────────
    const oldScopes = new Set<string>(original.selectedScopes || []);
    const newScopes = this.selectedScopes;
    const allScopeIds = new Set([...oldScopes, ...newScopes]);
    for (const scopeId of allScopeIds) {
      if (oldScopes.has(scopeId) !== newScopes.has(scopeId)) {
        const scopeLabel =
          this.template?.step2?.scopes?.find((s: any) => s.id === scopeId)?.label || scopeId;
        result.push({
          field: scopeId,
          label: scopeLabel,
          section: 'Change Scope',
          oldValue: oldScopes.has(scopeId) ? 'Selected' : 'Not selected',
          newValue: newScopes.has(scopeId) ? 'Selected' : 'Not selected',
        });
      }
    }
    // ── 3. Scope detail fields ────────────────────────────────────
    const scopeSections: any[] = Object.values(this.template?.scopeDetails || {});
    for (const section of scopeSections) {
      const sectionLabel: string = section.label || 'Scope Details';
      for (const f of (section.fields || [])) {
        const oldVal = original.scopeValues?.[f.field];
        const newVal = this.scopeValues?.[f.field];
        const parentChanged = isDiff(oldVal, newVal);
        const subChanges = collectSubs(getAllSubDefs(f), 'scope');
        if (parentChanged || subChanges.length > 0) {
          result.push({
            field: f.field,
            label: f.label || f.field,
            section: sectionLabel,
            oldValue: parentChanged ? (oldVal ?? '—') : null,
            newValue: parentChanged ? (newVal ?? '—') : null,
            subChanges: subChanges.length > 0 ? subChanges : undefined,
          });
        }
      }
    }
    // ── 4. Dynamic rows ───────────────────────────────────────────
    const allDynKeys = new Set([
      ...Object.keys(original.dynamicRows || {}),
      ...Object.keys(this.dynamicRows || {}),
    ]);
    for (const key of allDynKeys) {
      const oldRows = original.dynamicRows?.[key] || [];
      const newRows = this.dynamicRows?.[key] || [];
      if (isDiff(oldRows, newRows)) {
        // Find the field def to get a label and section
        let label = key;
        let section = 'Scope Details';
        for (const sec of scopeSections) {
          const found = (sec.fields || []).find((f: any) => f.field === key);
          if (found) { label = found.label || key; section = sec.label || section; break; }
        }
        result.push({
          field: key,
          label,
          section,
          oldValue: `${oldRows.length} row(s)`,
          newValue: `${newRows.length} row(s)`,
        });
      }
    }
    return result;
  }

  get changedFieldsList(): FieldChange[] {
    if (!this.editMode) return [];
    return this.getChangedFields();
  }

  getTotalChangeCount(fieldsChanged: any[]): number {
    if (!fieldsChanged?.length) return 0;
    return fieldsChanged.reduce((total: number, change: any) => {
      const parentChanged = change.oldValue !== null && change.oldValue !== undefined && !(change.oldValue === '—' && change.newValue === '—');
      const parentCount = parentChanged ? 1 : 0;
      const subCount = change.subChanges?.length || 0;
      return total + parentCount + subCount;
    }, 0);
  }

  // Show newest edits first (moved from summary component)
  get reversedEditHistory() {
    return [...this.editHistory].reverse();
  }

  formatHistoryDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** "Sep 28, 2026" — used in the Create modal's Start-from list */
  formatShortDate(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatChangeValue(val: any): string {
    if (val === null || val === undefined) return '—';
    if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '—';
    const str = String(val).trim();
    return str || '—';
  }

  isArrayValue(val: any): boolean {
    return Array.isArray(val) && val.length > 0;
  }

  formatChangeValueAsArray(val: any): string[] {
    if (Array.isArray(val)) return val.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    if (val === null || val === undefined) return [];
    const str = String(val).trim();
    return str ? [str] : [];
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.scopeToRemove) {
      this.cancelRemoveScope();
      return;
    }
    if (this.showDiscardModal) {
      this.cancelDiscard();
      return;
    }
    if (this.showHistoryDrawer) {
      this.closeHistoryDrawer();
    }
  }

  get canExport(): boolean {
    return !!this.selectedRelease && !!this.selectedDATeam && !!this.jiraBoardKey && this.selectedScopes.size > 0 && !this.isExporting;
  }

  async exportToConfluence(): Promise<void> {
    // Block in edit mode if nothing changed
    if (this.editMode && !this.hasFormChanged()) {
      this.noChangeMessage = 'No changes detected — nothing to update.';
      if (this._validationTimeout) clearTimeout(this._validationTimeout);
      this._validationTimeout = setTimeout(() => { this.noChangeMessage = null; }, 5000);
      return;
    }
    // Block in both modes until required / invalid fields are fixed (listed on the Review step)
    this.submitBlockers = this.computeSubmitBlockers();
    if (this.submitBlockers.length > 0) return;
    this.isExporting = true;
    this.exportError = null;
    this.exportSuccess = null;
    try {
      const payload: any = {
        step1: {
          daTeam: this.selectedDATeam,
          release: this.selectedRelease,
          jiraBoardKey: this.jiraBoardKey,
        },
        generalValues: this.getFormattedGeneralValues(),
        selectedScopes: Array.from(this.selectedScopes),
        scopeValues: this.scopeValues,
        dynamicRows: this.dynamicRows,
      };
// Only send the optional suffix — buildIntakeTitle on the backend
// already prepends "<release> - <boardKey> -"

payload.step1.intakeTitle = this.intakeTitleSuffix || '';
 

      let result: any;
      if (this.editMode && this.editPageId) {
        // Push update to existing page
        try {
          // Include editor identity if selected (no-login flow)
          if (this.selectedUser) payload.editedBy = { name: this.selectedUser.displayName, email: this.selectedUser.email, accountId: this.selectedUser.accountId };
          // Include changed fields for audit
          payload.fieldsChanged = this.getChangedFields();
          result = await this.apiService.request<any>('POST', `/api/tech-intake/intake/${this.editPageId}/push`, payload);
          this.exportSuccess = {
            pageId: result.pageId,
            pageUrl: result.pageUrl,
          };
          this.postExportState = 'success';
          // Append the new audit entry to local editHistory immediately
          // so the drawer reflects the latest edit without requiring a re-pull
          const newEntry = {
            editedBy: {
              name: this.selectedUser?.displayName || 'Unknown',
              email: this.selectedUser?.email || '',
              accountId: this.selectedUser?.accountId || '',
            },
            editedAt: new Date().toISOString(),
            fieldsChanged: this.getChangedFields(),
          } as any;
          this.editHistory = [...(this.editHistory || []), newEntry];
          // Reset snapshot so change detection is fresh for the next edit
          this._originalFormSnapshot = this.getFormStateSnapshot();
        } catch (err: any) {
          const status = err?.status || err?.error?.status;
          const msg = err?.error?.error || err?.message || 'Push failed';
          if (status === 409) {
            this.exportError = 'Version conflict — the page was modified since you loaded it. Please re-pull and try again.';
          } else {
            this.exportError = msg;
          }
          return;
        }
      } else {
        // Create new intake (existing flow)
        // Keep frontend hints for parent/space; backend resolves server-side
        payload.parentPageId = '1356094131';
        payload.spaceId = 'SSRELEASE';
        payload.daTeam = this.selectedDATeam;
        payload.release = this.selectedRelease;
        payload.jiraBoardKey = this.jiraBoardKey;
        payload.intakeTitle = this.intakeTitleSuffix;

        // Include creator identity if selected (no-login flow)
        if (this.selectedUser) payload.requestor = { name: this.selectedUser.displayName, email: this.selectedUser.email, accountId: this.selectedUser.accountId };
        try {
          result = await this.apiService.request<any>('POST', '/api/tech-intake/export', payload);
          this.exportSuccess = {
            pageId: result.page?.id || result.pageId || '',
            pageUrl: result.pageUrl || '',
          };
          // Immediately mark post-export success to drive success-screen UI
          this.postExportState = 'success';
        } catch (err: any) {
          const status = err?.status || err?.error?.status;
          if (status === 409 && err?.error?.exists && err?.error?.pageId) {
            this.exportError = 'An intake already exists for this release and team. Opening for editing…';
            const pageId = err.error.pageId;
            try {
              const data = await this.apiService.request<any>('GET', `/api/tech-intake/intake/${pageId}/pull`);
              const formData = data.formData || data;
              this.populateFormFromData(formData);
              this.editMode = true;
              this.editPageId = pageId;
              this.editIntakePages = [{ pageId, title: err.error.title || '', url: err.error.url || '', lastUpdated: null, updatedBy: null }];
              // Defaults + snapshot, back to the first step
              this.enterForm();
            } catch (pullErr) {
              console.error('Failed to pull existing intake:', pullErr);
              this.exportError = 'An intake exists but failed to load it for editing.';
            }
            return;
          }
          throw err;
        }
      }
    } catch (err: any) {
      this.exportError = err?.error?.error || err?.message || 'Export failed';
    } finally {
      this.isExporting = false;
    }
  }
}
