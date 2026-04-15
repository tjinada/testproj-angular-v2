import { Component, EventEmitter, Input, Output, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EnvironmentOption } from '../../services/config.service';
import { DynatraceService } from '../../services/dynatrace.service';

/**
 * Modal overlay for managing Dynatrace platform tokens.
 *
 * Two modes:
 *  - "setup": first-time experience — user must provide at least a Non-Prod
 *    token before they can use the app. The overlay cannot be dismissed.
 *  - "settings": opened via the settings gear — user can update tokens or
 *    add an optional Prod token. The overlay can be closed.
 */
@Component({
  selector: 'app-token-setup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './token-setup.component.html',
  styleUrls: ['./token-setup.component.css']
})
export class TokenSetupComponent implements OnInit {
  /** "setup" = first-time, "settings" = gear button */
  @Input() mode: 'setup' | 'settings' = 'setup';

  /** Available environments from config */
  @Input() environments: EnvironmentOption[] = [];

  /** Token management URLs per environment (from .env) */
  @Input() tokenUrls: Record<string, string> = {};

  /** Emitted when user saves tokens and the modal should close */
  @Output() saved = new EventEmitter<void>();

  /** Emitted when user closes the modal (settings mode only) */
  @Output() closed = new EventEmitter<void>();

  /** Token input values keyed by environment ID */
  tokenValues: Record<string, string> = {};

  /** Tracks which tokens have been saved (for feedback) */
  savedFeedback: Record<string, boolean> = {};

  /** Error message for validation */
  errorMsg = '';

  constructor(private cdr: ChangeDetectorRef) {}

  /** The first non-prod environment — required in setup mode */
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
    // Pre-fill inputs with existing stored tokens
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

    // Clear the "Saved" feedback after 2s
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

  /** Checks whether a token is already persisted in localStorage for this env */
  hasStoredToken(envId: string): boolean {
    return !!DynatraceService.getStoredToken(envId);
  }

  /** Continue / close the modal */
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
