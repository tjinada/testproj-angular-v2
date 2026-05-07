import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { Release, ReleaseType } from '../../../../models/release-workflow.model';

type Mode = 'create' | 'edit';

@Component({
  selector: 'app-create-release',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './create-release.component.html',
  styleUrl: './create-release.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateReleaseComponent implements OnInit, OnChanges {
  @Input() mode: Mode = 'create';
  /** Required when mode === 'edit'. Release will be fetched and form pre-populated. */
  @Input() editingReleaseId: string | null = null;

  /** Emitted when the user cancels. */
  @Output() cancel = new EventEmitter<void>();
  /** Emitted with the releaseId after a successful create or update. */
  @Output() saved = new EventEmitter<string>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);

  // form fields (editable in both modes unless noted)
  releaseId = '';            // read-only in edit mode
  title = '';
  type = signal<ReleaseType>('bundle');   // read-only in edit mode
  sheriff = '';
  preProdDate = '';
  prodDate = '';
  jiraTracker = '';
  intakePageId = '';
  intakeSheetUrl = '';
  fixVersion = '';
  envMatrixPrUrl = '';
  branchCdbUi = '';
  branchCdbUiConfigs = '';   // editable in EDIT mode only — populated mid-flight by Stage 2
  branchFreddy = '';

  /**
   * cdbUiConfigs is populated mid-flight by Stage 2 (the sub-step "create CDB
   * UI Configs branch off master"). It's not part of the create wizard — the
   * branch doesn't exist yet at intake. The edit wizard exposes it so the
   * sheriff can paste the URL after creating the branch in GitHub.
   *
   * In edit mode, branchCdbUiConfigs is the form field. In create mode this
   * stays empty and the value goes to the backend as null.
   */

  readonly submitting = signal<boolean>(false);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    if (this.mode === 'edit' && this.editingReleaseId) {
      this.loadForEdit(this.editingReleaseId);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Re-fetch if the parent changes the editingReleaseId after init
    if (changes['editingReleaseId'] && !changes['editingReleaseId'].firstChange && this.mode === 'edit' && this.editingReleaseId) {
      this.loadForEdit(this.editingReleaseId);
    }
  }

  private loadForEdit(releaseId: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getById(releaseId).subscribe({
      next: (release: Release) => {
        this.releaseId      = release.releaseId;
        this.title          = release.title;
        this.type.set(release.type);
        this.sheriff        = release.sheriff;
        this.preProdDate    = release.metadata.preProdDate ?? '';
        this.prodDate       = release.metadata.prodDate ?? '';
        this.jiraTracker    = release.metadata.jiraTracker ?? '';
        this.intakePageId   = release.metadata.intakePageId ?? '';
        this.intakeSheetUrl = release.metadata.intakeSheetUrl ?? '';
        this.fixVersion     = release.metadata.fixVersion ?? '';
        this.envMatrixPrUrl = release.metadata.envMatrixPrUrl ?? '';
        this.branchCdbUi          = release.metadata.branches?.cdbUi ?? '';
        this.branchCdbUiConfigs   = release.metadata.branches?.cdbUiConfigs ?? '';
        this.branchFreddy         = release.metadata.branches?.freddy ?? '';
        this.loading.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load release for edit', err);
        this.error.set(err?.error?.error ?? 'Failed to load release');
        this.loading.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  setType(t: ReleaseType): void {
    if (this.mode === 'edit') return;   // type is locked in edit mode
    this.type.set(t);
  }

  onCancel(): void {
    this.cancel.emit();
  }

  onSubmit(): void {
    this.error.set(null);

    if (this.mode === 'create') {
      if (!this.releaseId.trim() || !this.title.trim() || !this.sheriff.trim()) {
        this.error.set('Release ID, Title, and Sheriff are required.');
        return;
      }
    } else {
      if (!this.title.trim() || !this.sheriff.trim()) {
        this.error.set('Title and Sheriff are required.');
        return;
      }
    }

    this.submitting.set(true);

    const metadata = {
      preProdDate:    this.preProdDate || null,
      prodDate:       this.prodDate || null,
      jiraTracker:    this.jiraTracker.trim() || null,
      intakePageId:   this.intakePageId.trim() || null,
      intakeSheetUrl: this.intakeSheetUrl.trim() || null,
      fixVersion:     this.fixVersion.trim() || null,
      envMatrixPrUrl: this.envMatrixPrUrl.trim() || null,
      branches: {
        cdbUi:        this.branchCdbUi.trim() || null,
        freddy:       this.branchFreddy.trim() || null,
        // cdbUiConfigs is editable in EDIT mode only. In CREATE mode the
        // form field stays empty (the branch doesn't exist yet at intake;
        // it's created during Stage 2 and pasted in via edit afterward).
        cdbUiConfigs: this.branchCdbUiConfigs.trim() || null,
      },
    };

    const obs$ = this.mode === 'create'
      ? this.api.create({
          releaseId: this.releaseId.trim(),
          title: this.title.trim(),
          type: this.type(),
          sheriff: this.sheriff.trim(),
          metadata,
        })
      : this.api.update(this.releaseId, {
          title: this.title.trim(),
          sheriff: this.sheriff.trim(),
          metadata,
        });

    obs$.subscribe({
      next: (resp) => {
        this.submitting.set(false);
        this.saved.emit(resp.release.releaseId);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error(`${this.mode} release failed`, err);
        const msg =
          err?.error?.error
          ?? err?.message
          ?? `Failed to ${this.mode === 'create' ? 'create' : 'update'} release`;
        this.error.set(msg);
        this.submitting.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  // ---------- presentational helpers ----------

  isEdit(): boolean {
    return this.mode === 'edit';
  }

  pageTitle(): string {
    return this.isEdit() ? `Edit ${this.releaseId || 'release'}` : 'Start a new release';
  }

  pageSubtitle(): string {
    return this.isEdit()
      ? 'Update title, sheriff, dates, and tracker references. Release ID and type are fixed once created.'
      : `Enter the basics. Stage 1 will run the API checks to validate links and IDs once the release is created.`;
  }

  submitLabel(): string {
    if (this.submitting()) return this.isEdit() ? 'Saving…' : 'Creating…';
    return this.isEdit() ? 'Save changes' : 'Start release';
  }

  breadcrumbCurrent(): string {
    return this.isEdit() ? `Edit ${this.releaseId || ''}`.trim() : 'New release';
  }
}
