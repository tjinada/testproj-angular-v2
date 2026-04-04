export interface EnvironmentConfig {
  name: string;
  label: string;
}

export const ENVIRONMENTS: EnvironmentConfig[] = [
  { name: 'NON-PROD', label: 'Non-Prod' },
  { name: 'PRE-PROD', label: 'Pre-Prod' },
  { name: 'PROD', label: 'Production' }
];
