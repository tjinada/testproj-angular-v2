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
  individualUserToken: boolean;
  tokenUrls: Record<string, string>;
}

const DEFAULT_ENVIRONMENTS: EnvironmentOption[] = [
  { id: 'NON-PROD', label: 'Non-Prod', isProd: false }
];

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly _config = signal<AppConfig>({
    envHostnamePatterns: [],
    environments: DEFAULT_ENVIRONMENTS,
    individualUserToken: false,
    tokenUrls: {}
  });
  readonly config = this._config.asReadonly();

  constructor(private http: HttpClient) {}

  async load(): Promise<void> {
    try {
      const cfg = await firstValueFrom(this.http.get<AppConfig>('/api/error-analyzer/config'));
      this._config.set({
        envHostnamePatterns: cfg?.envHostnamePatterns || [],
        environments: (cfg?.environments && cfg.environments.length > 0)
          ? cfg.environments
          : DEFAULT_ENVIRONMENTS,
        individualUserToken: cfg?.individualUserToken === true,
        tokenUrls: cfg?.tokenUrls || {}
      });
    } catch (err) {
      console.warn('[ConfigService] Failed to load /api/error-analyzer/config, using defaults', err);
    }
  }

  getEnvHostnamePatterns(): string[] {
    return this._config().envHostnamePatterns;
  }

  getEnvironments(): EnvironmentOption[] {
    return this._config().environments;
  }

  isIndividualUserToken(): boolean {
    return this._config().individualUserToken;
  }

  getTokenUrls(): Record<string, string> {
    return this._config().tokenUrls;
  }
}
