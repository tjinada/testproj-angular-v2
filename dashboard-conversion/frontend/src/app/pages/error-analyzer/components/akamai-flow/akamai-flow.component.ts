import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AkamaiService } from '../../services/akamai.service';
import {
  isHostnameError,
  type AkamaiFlowError,
  type AkamaiFlowResult
} from '../../models/akamai.model';
import { AkamaiGraphComponent } from './akamai-graph/akamai-graph.component';

/**
 * Akamai Flow tab.
 *
 * Single URL input + Submit. Calls POST /api/akamai/flow and shows the
 * destination path plus the request-to-origin flow graph. The backend
 * does all resolution — this component only renders the result.
 */
@Component({
  selector: 'app-akamai-flow',
  standalone: true,
  imports: [CommonModule, FormsModule, AkamaiGraphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './akamai-flow.component.html',
  styleUrls: ['./akamai-flow.component.scss']
})
export class AkamaiFlowComponent {

  private readonly akamai = inject(AkamaiService);

  // ── Form state ─────────────────────────────────────────────────

  protected readonly url = signal('');
  protected readonly colour = signal('');   // pick — only for a GSS host with no colour prefix
  protected readonly site = signal('');     // pick — only for a GSS host

  protected readonly colourOptions = ['blue', 'green'];

  // Hostname classification, derived from the URL as typed.
  private readonly hostClass = computed(() => classifyHostnameFromUrl(this.url()));
  protected readonly isGss = computed(() => this.hostClass().isGss);
  protected readonly needsColour = computed(() => this.isGss() && !this.hostClass().colourPrefix);
  protected readonly needsSite = computed(() => this.isGss());
  protected readonly pairSites = computed(() => this.hostClass().pairSites);

  // ── Async state ────────────────────────────────────────────────

  protected readonly loading = signal(false);
  protected readonly result = signal<AkamaiFlowResult | null>(null);
  protected readonly copied = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly hostnameErrorBody = signal<{
    configuredHostnameCount: number;
    configuredHostnamesSample: string[];
  } | null>(null);

  // ── Derived state ──────────────────────────────────────────────

  readonly canSubmit = computed(() => {
    if (this.loading() || this.url().trim().length === 0) return false;
    if (this.needsColour() && !this.colour()) return false;
    if (this.needsSite() && !this.site()) return false;
    return true;
  });

  // ── Event handlers ─────────────────────────────────────────────

  submit(): void {
    const value = this.url().trim();
    if (!value || this.loading()) return;

    this.errorMessage.set(null);
    this.hostnameErrorBody.set(null);
    this.result.set(null);
    this.loading.set(true);

    this.akamai.resolveFlow(value, this.colour(), this.site()).subscribe({
      next: (res) => {
        this.result.set(res);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.handleError(err);
        this.loading.set(false);
      }
    });
  }

  onUrlKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.canSubmit()) {
      event.preventDefault();
      this.submit();
    }
  }

  copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }

  reset(): void {
    this.url.set('');
    this.colour.set('');
    this.site.set('');
    this.result.set(null);
    this.errorMessage.set(null);
    this.hostnameErrorBody.set(null);
  }

  // ── Error handling ─────────────────────────────────────────────

  private handleError(err: HttpErrorResponse): void {
    const body = err.error as AkamaiFlowError | undefined;

    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      this.errorMessage.set(body.error);

      if (err.status === 404 && isHostnameError(body)) {
        this.hostnameErrorBody.set({
          configuredHostnameCount: body.configuredHostnameCount,
          configuredHostnamesSample: body.configuredHostnamesSample
        });
      }
      return;
    }

    this.errorMessage.set(err.message || 'Request failed');
  }
}


// ── Hostname classification (mirrors backend classifyHostname) ──────

interface UrlHostClass {
  colourPrefix?: 'blue' | 'green';
  isGss: boolean;
  pairSites: string[];
}

const ENV_PAIRS: Record<string, string[]> = {
  '34': ['qa3', 'qa4'],
  '56': ['qa5', 'qa6'],
  '78': ['qa7', 'qa8'],
  '910': ['qa9', 'qa10'],
  '1112': ['qa11', 'qa12']
};

function classifyHostnameFromUrl(raw: string): UrlHostClass {
  let host = '';
  try {
    host = new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const colourPrefix = host.startsWith('blue.') ? 'blue' : host.startsWith('green.') ? 'green' : undefined;
  const gss = host.match(/gss-qa(\d+)/);
  return {
    colourPrefix,
    isGss: !!gss,
    pairSites: gss ? ENV_PAIRS[gss[1]] || [] : []
  };
}
