import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface EnvironmentOption {
  id: string;
  label: string;
  isProd: boolean;
}

interface AppConfig {
  envHostnamePatterns: string[];
  environments: EnvironmentOption[];
}

const DEFAULT_ENVIRONMENTS: EnvironmentOption[] = [
  { id: 'NON-PROD', label: 'Non-Prod', isProd: false }
];

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly _config = signal<AppConfig>({
    envHostnamePatterns: [],
    environments: DEFAULT_ENVIRONMENTS
  });
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
        envHostnamePatterns: cfg?.envHostnamePatterns || [],
        environments: (cfg?.environments && cfg.environments.length > 0)
          ? cfg.environments
          : DEFAULT_ENVIRONMENTS
      });
    } catch (err) {
      console.warn('[ConfigService] Failed to load /api/config, using defaults', err);
    }
  }

  getEnvHostnamePatterns(): string[] {
    return this._config().envHostnamePatterns;
  }

  getEnvironments(): EnvironmentOption[] {
    return this._config().environments;
  }
}
