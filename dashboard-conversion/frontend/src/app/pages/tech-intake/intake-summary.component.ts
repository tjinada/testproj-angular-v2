import { Component, Input, Output, EventEmitter } from '@angular/core';
import type { FieldChange } from './tech-intake.component';
import { CommonModule } from '@angular/common';
@Component({
  selector: 'app-intake-summary',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './intake-summary.component.html',
  styleUrls: ['./intake-summary.component.scss'],
})
export class IntakeSummaryComponent {
  @Input() template: any;
  @Input() selectedRelease = '';
  @Input() selectedDATeam = '';
  @Input() jiraBoardKey = '';
  @Input() intakeTitleSuffix = '';
  @Input() selectedUser: { accountId: string; displayName: string; email: string } | null = null;
  @Input() generalValues: Record<string, any> = {};
  @Input() selectedScopes: Set<string> = new Set();
  @Input() scopeValues: Record<string, any> = {};
  @Input() dynamicRows: Record<string, any[][]> = {};
  @Input() editMode = false;
  
  @Input() isExporting = false;
  @Input() exportError: string | null = null;
  @Input() exportSuccess: { pageId: string; pageUrl: string } | null = null;
  @Output() backToEdit = new EventEmitter<void>();
  @Output() submit = new EventEmitter<void>();
  @Input() changedFields: FieldChange[] = [];
  @Input() noChangeMessage: string | null = null;
  formatChangeValue(val: any): string {
    if (val === null) return '';           // parent-unchanged marker — render nothing
    if (val === undefined) return '—';
    if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '—';
    const str = String(val).trim();
    return str || '—';
  }
  // Confirm modal state
  showConfirmModal = false;
  openConfirmModal(): void { this.showConfirmModal = true; }
  closeConfirmModal(): void { this.showConfirmModal = false; }
  confirmAndSubmit(): void { this.showConfirmModal = false; this.submit.emit(); }
  // No-changes modal state (user must acknowledge)
  showNoChangesModal = false;
  openNoChangesModal(): void { this.showNoChangesModal = true; }
  closeNoChangesModal(): void { this.showNoChangesModal = false; }
  isScopeSelected(scopeId: string): boolean {
    return this.selectedScopes.has(scopeId);
  }
  getVisibleScopeSections(): { key: string; section: any }[] {
    if (!this.template?.scopeDetails) return [];
    return Object.entries(this.template.scopeDetails)
      .map(([k, v]) => ({ key: k, section: v as any }))
      .filter((s) => this.selectedScopes.has(s.section.showWhen));
  }
  isArray(val: any): boolean {
    return Array.isArray(val);
  }

  // Handler for the primary action button — ensures users get feedback when
  // attempting to submit an edit with no detected changes.
  handlePrimaryActionClick(): void {
    if (this.editMode) {
      if (!this.changedFields || this.changedFields.length === 0) {
        this.openNoChangesModal();
        return;
      }
      this.openConfirmModal();
      return;
    }
    this.submit.emit();
  }

  // (Edit history rendering moved to parent component)
}
