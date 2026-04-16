import { Component, EventEmitter, Input, Output, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EnvironmentOption } from '../../services/config.service';
import { DynatraceService } from '../../services/dynatrace.service';

@Component({
  selector: 'app-token-setup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './token-setup.component.html',
  styleUrls: ['./token-setup.component.scss']
})
export class TokenSetupComponent implements OnInit {
  @Input() mode: 'setup' | 'settings' = 'setup';
  @Input() environments: EnvironmentOption[] = [];
  @Input() tokenUrls: Record<string, string> = {};

  @Output() saved = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  tokenValues: Record<string, string> = {};
  savedFeedback: Record<string, boolean> = {};
  errorMsg = '';

  constructor(private cdr: ChangeDetectorRef) {}

  get requiredEnvId(): string {
    const nonProd = this.environments.find(e => !e.isProd);
    return nonProd?.id || 'NON-PROD';
  }

  get requiredEnvLabel(): string {
    const nonProd = this.environments.find(e => !e.isProd);
    return nonProd?.label || 'Non-Prod';
  }

  get hasRequiredToken(): boolean {
    const stored = DynatraceService.getStoredToken(this.requiredEnvId);
    const input = this.tokenValues[this.requiredEnvId]?.trim();
    return !!(stored || input);
  }

  ngOnInit(): void {
    for (const env of this.environments) {
      const existing = DynatraceService.getStoredToken(env.id);
      this.tokenValues[env.id] = existing || '';
    }
  }

  getTokenUrl(envId: string): string {
    return this.tokenUrls[envId] || '';
  }

  saveToken(envId: string): void {
    const value = this.tokenValues[envId]?.trim();
    if (!value) return;

    DynatraceService.saveToken(envId, value);
    this.savedFeedback[envId] = true;
    this.errorMsg = '';
    this.cdr.detectChanges();

    setTimeout(() => {
      this.savedFeedback[envId] = false;
      this.cdr.detectChanges();
    }, 2000);
  }

  clearToken(envId: string): void {
    DynatraceService.removeToken(envId);
    this.tokenValues[envId] = '';
    this.savedFeedback[envId] = false;
    this.cdr.detectChanges();
  }

  hasStoredToken(envId: string): boolean {
    return !!DynatraceService.getStoredToken(envId);
  }

  onContinue(): void {
    if (this.mode === 'setup' && !this.hasRequiredToken) {
      this.errorMsg = `A ${this.requiredEnvLabel} token is required to continue.`;
      this.cdr.detectChanges();
      return;
    }
    this.saved.emit();
  }

  onClose(): void {
    this.closed.emit();
  }
}
