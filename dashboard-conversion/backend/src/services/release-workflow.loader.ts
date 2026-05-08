/**
 * Release Workflow — YAML loader
 *
 * Reads the workflow YAML at boot, validates it, looks up runner factories
 * by name, and produces the four exports the rest of the app consumes:
 *
 *   STAGE_TEMPLATE       — canonical 10-stage structure for new releases
 *   STAGE_RUNNERS        — per-stage map of check ID → runner function
 *   cloneStageTemplate() — deep clone of STAGE_TEMPLATE
 *   stagesUsingField()   — stages whose sub-steps reference a metadata field
 *
 * If validation fails, this module throws at import time so the pod fails
 * to start with a clear error. That's the intentional failure mode.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  Lookup priority for the YAML file:
 *    1. $RELEASE_WORKFLOW_CONFIG_PATH env var, if set
 *    2. ./backend/config/release-workflow.yaml (relative to cwd)
 *    3. <this-dir>/../../config/release-workflow.yaml (bundled fallback)
 *
 *  The first existing file wins. This lets ConfigMap mounts override the
 *  bundled default by setting the env var to the mount path.
 *
 *  Schema strictness: lenient. Unknown fields are ignored. Missing optional
 *  fields get sensible defaults. Wrong types still fail.
 * ─────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

import { Stage, StageKind, StageStatus } from '../models/release-workflow.model';
import {
  CheckRunner,
  StageRunnerMap,
  FACTORY_REGISTRY,
  FactoryFn,
} from './release-workflow.runners';

// ============================================================================
// Schemas
// ============================================================================

/**
 * Sub-step in YAML.
 *
 * `autoTickedBy` defaults to []. `editableField` is optional. Unknown fields
 * are silently ignored (lenient mode).
 */
const SubStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  autoTickedBy: z.array(z.string()).default([]),
  editableField: z.string().optional(),
});

/**
 * Check in YAML. The runner string is validated against FACTORY_REGISTRY at
 * build time, not in the schema (better error messages).
 */
const CheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  runner: z.string().min(1),
  config: z.record(z.string(), z.any()).default({}),
});

/**
 * Stage in YAML. Defaults: kind='sequential', initialStatus='locked',
 * dependsOn=[], subSteps=[], checks=[]. blocks is optional (parallel only).
 */
const StageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['sequential', 'parallel']).default('sequential'),
  initialStatus: z.enum(['locked', 'ready']).default('locked'),
  dependsOn: z.array(z.string()).default([]),
  blocks: z.array(z.string()).optional(),
  subSteps: z.array(SubStepSchema).default([]),
  checks: z.array(CheckSchema).default([]),
});

const WorkflowSchema = z.object({
  stages: z.array(StageSchema).min(1),
});

type WorkflowYaml = z.infer<typeof WorkflowSchema>;
type StageYaml = z.infer<typeof StageSchema>;

// ============================================================================
// Path resolution
// ============================================================================

function resolveYamlPath(): string {
  const envPath = process.env.RELEASE_WORKFLOW_CONFIG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const cwdPath = path.resolve(process.cwd(), 'backend/config/release-workflow.yaml');
  if (fs.existsSync(cwdPath)) return cwdPath;

  // Fallback: relative to this file (works when running compiled JS or ts-node).
  // From src/services/, walk up two levels to backend/, then into config/.
  const bundled = path.resolve(__dirname, '..', '..', 'config', 'release-workflow.yaml');
  if (fs.existsSync(bundled)) return bundled;

  throw new Error(
    `Release workflow YAML not found. Looked in: ` +
    `RELEASE_WORKFLOW_CONFIG_PATH (${envPath ?? 'unset'}), ${cwdPath}, ${bundled}`,
  );
}

// ============================================================================
// Load + validate + build
// ============================================================================

function loadAndParse(): WorkflowYaml {
  const filePath = resolveYamlPath();
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);

  console.log(`[release-workflow] Loading workflow from ${filePath}`);

  const result = WorkflowSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Release workflow YAML failed validation:\n${issues}`);
  }
  return result.data;
}

/**
 * Cross-validation that Zod can't easily express:
 *   - Stage IDs are unique
 *   - Sub-step IDs unique within their stage
 *   - Check IDs unique within their stage
 *   - dependsOn references real stage IDs
 *   - autoTickedBy references real check IDs in the same stage
 *   - runner names exist in FACTORY_REGISTRY
 */
function crossValidate(workflow: WorkflowYaml): void {
  const errors: string[] = [];

  const stageIds = new Set<string>();
  for (const stage of workflow.stages) {
    if (stageIds.has(stage.id)) errors.push(`Duplicate stage ID: ${stage.id}`);
    stageIds.add(stage.id);
  }

  for (const stage of workflow.stages) {
    const subStepIds = new Set<string>();
    const checkIds = new Set<string>();

    for (const sub of stage.subSteps) {
      if (subStepIds.has(sub.id)) errors.push(`${stage.id}: duplicate sub-step ID '${sub.id}'`);
      subStepIds.add(sub.id);
    }
    for (const check of stage.checks) {
      if (checkIds.has(check.id)) errors.push(`${stage.id}: duplicate check ID '${check.id}'`);
      checkIds.add(check.id);
    }

    for (const dep of stage.dependsOn) {
      if (!stageIds.has(dep)) errors.push(`${stage.id}: dependsOn references unknown stage '${dep}'`);
    }

    if (stage.blocks) {
      for (const blocked of stage.blocks) {
        if (!stageIds.has(blocked)) {
          errors.push(`${stage.id}: blocks references unknown stage '${blocked}'`);
        }
      }
    }

    for (const sub of stage.subSteps) {
      for (const ref of sub.autoTickedBy) {
        if (!checkIds.has(ref)) {
          errors.push(`${stage.id}.${sub.id}: autoTickedBy references unknown check '${ref}'`);
        }
      }
    }

    for (const check of stage.checks) {
      if (!FACTORY_REGISTRY[check.runner]) {
        errors.push(
          `${stage.id}.${check.id}: unknown runner '${check.runner}' ` +
          `(available: ${Object.keys(FACTORY_REGISTRY).join(', ')})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Release workflow YAML failed cross-validation:\n  ${errors.join('\n  ')}`);
  }
}

/**
 * Build a Stage[] (the canonical template) from validated YAML.
 * Each stage gets a fresh "blank slate" state — sub-steps unchecked, checks
 * pending, timestamps null.
 */
function buildStageTemplate(workflow: WorkflowYaml): Stage[] {
  return workflow.stages.map((def, idx) => ({
    id: def.id,
    displayOrder: idx + 1,
    name: def.name,
    kind: def.kind as StageKind,
    status: def.initialStatus as StageStatus,
    startedAt: null,
    closedAt: null,
    subSteps: def.subSteps.map((s) => ({
      id: s.id,
      label: s.label,
      state: 'unchecked' as const,
      source: null,
      autoTickedBy: s.autoTickedBy,
      editableField: s.editableField ?? null,
      completedAt: null,
      completedBy: null,
    })),
    automatedChecks: def.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: 'pending' as const,
      lastRunAt: null,
      result: null,
      errorMessage: null,
    })),
    notes: [],
    override: null,
    dependsOn: def.dependsOn,
    ...(def.blocks ? { blocks: def.blocks } : {}),
  }));
}

/**
 * Build the per-stage runner map from validated YAML by looking up each
 * check's runner name in FACTORY_REGISTRY and instantiating with its config.
 * Cross-validation has already confirmed every runner name exists.
 */
function buildStageRunners(workflow: WorkflowYaml): Record<string, StageRunnerMap> {
  const runners: Record<string, StageRunnerMap> = {};

  for (const stage of workflow.stages) {
    const stageMap: StageRunnerMap = {};
    for (const check of stage.checks) {
      const factory = FACTORY_REGISTRY[check.runner] as FactoryFn;
      try {
        stageMap[check.id] = factory(check.config);
      } catch (err: any) {
        throw new Error(
          `Failed to build runner '${check.runner}' for ${stage.id}.${check.id}: ` +
          `${err?.message ?? err}`,
        );
      }
    }
    runners[stage.id] = stageMap;
  }

  return runners;
}

// ============================================================================
// Module-load: do everything once, fail fast on error
// ============================================================================

const workflow = loadAndParse();
crossValidate(workflow);

console.log(
  `[release-workflow] Validated ${workflow.stages.length} stage(s); ` +
  `${workflow.stages.reduce((n, s) => n + s.subSteps.length, 0)} sub-step(s); ` +
  `${workflow.stages.reduce((n, s) => n + s.checks.length, 0)} check(s) wired`,
);

// ============================================================================
// Exports — same surface as the previous hardcoded module
// ============================================================================

export const STAGE_TEMPLATE: Stage[] = buildStageTemplate(workflow);

export const STAGE_RUNNERS: Record<string, StageRunnerMap> = buildStageRunners(workflow);

export function cloneStageTemplate(): Stage[] {
  return JSON.parse(JSON.stringify(STAGE_TEMPLATE));
}

/**
 * For a given metadata field path, returns the IDs of stages whose sub-steps
 * declare it as their `editableField`.
 */
export function stagesUsingField(field: string): string[] {
  const stages = new Set<string>();
  for (const stage of workflow.stages) {
    if (stage.subSteps.some((s) => s.editableField === field)) {
      stages.add(stage.id);
    }
  }
  return [...stages];
}

// Re-export types from the runner library so the service keeps a stable import.
export type { CheckRunner, StageRunnerMap } from './release-workflow.runners';
