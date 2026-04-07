import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

interface AppConfig {
  envHostnamePatterns: string[];
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly _config = signal<AppConfig>({ envHostnamePatterns: [] });
  readonly config = this._config.asReadonly();

  constructor(private http: HttpClient) {}

  /**
   * Fetches config from the backend once. Idempotent — safe to call from
   * multiple components on init. Failures fall back to empty defaults so
   * the app keeps working without env-derived patterns.
   */
  async load(): Promise<void> {
    try {
      const cfg = await firstValueFrom(this.http.get<AppConfig>('/api/config'));
      this._config.set({
        envHostnamePatterns: cfg?.envHostnamePatterns || []
      });
    } catch (err) {
      console.warn('[ConfigService] Failed to load /api/config, using defaults', err);
    }
  }

  getEnvHostnamePatterns(): string[] {
    return this._config().envHostnamePatterns;
  }
}
