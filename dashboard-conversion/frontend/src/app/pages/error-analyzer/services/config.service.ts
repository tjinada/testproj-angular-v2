import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface EnvironmentOption {
  id: string;
  label: string;
  isProd: boolean;
}

export interface OpenSearchIndexOption {
  label: string;
  value: string;
}

interface AppConfig {
  envHostnamePatterns: string[];
  environments: EnvironmentOption[];
  individualUserToken: boolean;
  tokenUrls: Record<string, string>;
  openSearchIndices: OpenSearchIndexOption[];
}

const DEFAULT_ENVIRONMENTS: EnvironmentOption[] = [
  { id: 'NON-PROD', label: 'Non-Prod', isProd: false }
];

const DEFAULT_INDICES: OpenSearchIndexOption[] = [
  { label: 'channels-olb-*', value: 'channels-olb-*' }
];

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly _config = signal<AppConfig>({
    envHostnamePatterns: [],
    environments: DEFAULT_ENVIRONMENTS,
    individualUserToken: false,
    tokenUrls: {},
    openSearchIndices: DEFAULT_INDICES
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
        tokenUrls: cfg?.tokenUrls || {},
        openSearchIndices: (cfg?.openSearchIndices && cfg.openSearchIndices.length > 0)
          ? cfg.openSearchIndices
          : DEFAULT_INDICES
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

  getOpenSearchIndices(): OpenSearchIndexOption[] {
    return this._config().openSearchIndices;
  }
}
