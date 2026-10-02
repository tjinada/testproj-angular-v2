import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface IntakeFieldDef {
  field: string;
  label?: string;
  type: string;
  hint?: string;
  required?: boolean;
  source?: string;
  auto?: string;
  options?: (string | { label: string; hasLink?: boolean })[];
  hasDetails?: boolean;
  detailField?: string;
  columns?: string[];
  conditionalFields?: Record<string, IntakeFieldDef[]>;
  // NEW rendering hints
  render?: 'split-no' | 'split-last' | 'per-option-row';
  skipRender?: boolean;
  placeholder?: string;
  // Value pre-selected when the form starts and the field has no value (Option B)
  default?: string | string[];
  // Checkbox option that clears all others when ticked (and is cleared by any other)
  exclusive?: string;
  // detailField must be filled whenever its textarea is visible
  detailRequired?: boolean;
}

export interface IntakeScopeDef {
  id: string;
  label: string;
}

export interface IntakeGeneralDef {
  label: string;
  fields: IntakeFieldDef[];
}

export interface IntakeSectionDef {
  label: string;
  showWhen: string;
  fields: IntakeFieldDef[];
}

export interface IntakeTemplate {
  pageTitle: string;
  step1: IntakeFieldDef[];
  general: IntakeGeneralDef;
  step2: { label: string; scopes: IntakeScopeDef[] };
  scopeDetails: Record<string, IntakeSectionDef>;
  // NEW: rendering order and synthetic blocks
  renderOrder?: { field?: string; synthetic?: string; source?: string }[];
  synthetics?: Record<string, any>;
}

let cachedTemplate: IntakeTemplate | null = null;

export function loadIntakeTemplate(): IntakeTemplate {
  if (cachedTemplate && process.env.NODE_ENV !== 'development') return cachedTemplate;
  const yamlPath = path.resolve(__dirname, '..', 'config', 'intake-template.yaml');
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Intake template YAML not found at: ${yamlPath}`);
  }
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const parsed = yaml.load(raw) as IntakeTemplate;
  if (!parsed || !parsed.step1 || !parsed.general || !parsed.step2 || !parsed.scopeDetails) {
    throw new Error('Intake template YAML is missing required sections (step1, general, step2, scopeDetails)');
  }
  cachedTemplate = parsed;
  return cachedTemplate;
}

export default loadIntakeTemplate;
