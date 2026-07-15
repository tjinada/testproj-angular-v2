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
 *    1. $RELEASE_WORKFLOW_CONFIG_PATH env var, if set (resolved against cwd)
 *    2. <this-dir>/../config/release-workflow.yaml (bundled fallback)
 *
 *  The first existing file wins. This lets ConfigMap mounts override the
 *  bundled default by setting the env var to the mount path.
 *
 *  Schema strictness: lenient. Unknown fields are ignored. Missing optional
 *  fields get sensible defaults. Wrong types still fail.
 *
 *  Sub-step → check synthesis:
 *    A sub-step with `runner: someCheck` becomes BOTH a sub-step entry AND
 *    a synthesized AutomatedCheck entry. The check inherits the sub-step's
 *    label and is given a derived ID. The runner factory is invoked with
 *    `{ field: subStep.editableField }`. The sub-step is wired to its
 *    synthesized check via autoTickedBy.
 *
 *    A sub-step without a runner is purely manual — no check is synthesized.
 *
 *    A sub-step with a runner but no editableField is a YAML error and the
 *    loader rejects loudly at boot.
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
  RUNNER_PLACEHOLDERS,
  RUNNER_INPUT_TYPES,
} from './release-workflow.runners';

// ============================================================================
// Schemas
// ============================================================================

/**
 * Sub-step in YAML. `runner` is optional — sub-steps without it are
 * purely manual. `editableField` is optional in the schema, but cross-
 * validation requires it when `runner` is set. `placeholder` overrides
 * the runner's default placeholder text.
 */
const SubStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  track: z.enum(['generic', 'cdbui', 'cdbbos']),
  editableField: z.string().optional(),
  inputType: z.enum(['text', 'textarea']).optional(),
  runner: z.string().optional(),
  placeholder: z.string().optional(),
  helpUrl: z.string().optional(),
  helpUrlLabel: z.string().optional(),
});

/**
 * Stage in YAML. Defaults: kind='sequential', initialStatus='locked',
 * dependsOn=[], subSteps=[]. blocks is optional (parallel only).
 */
const StageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['sequential', 'parallel']).default('sequential'),
  initialStatus: z.enum(['locked', 'ready']).default('locked'),
  dependsOn: z.array(z.string()).default([]),
  blocks: z.array(z.string()).optional(),
  subSteps: z.array(SubStepSchema).default([]),
});

const WorkflowSchema = z.object({
  stages: z.array(StageSchema).min(1),
});

type WorkflowYaml = z.infer<typeof WorkflowSchema>;

// ============================================================================
// Path resolution
// ============================================================================

function resolveYamlPath(): string {
  const envPath = process.env.RELEASE_WORKFLOW_CONFIG_PATH;
  if (envPath) {
    // Resolve against cwd if it's relative, then check existence.
    const resolved = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
    if (fs.existsSync(resolved)) return resolved;
  }

  // Fallback: relative to this file (works whether running compiled JS from
  // dist/ or ts-node from src/). From src/services/ we walk one level up to
  // src/, then into config/.
  const bundled = path.resolve(__dirname, '..', 'config', 'release-workflow.yaml');
  if (fs.existsSync(bundled)) return bundled;

  throw new Error(
    `Release workflow YAML not found. Looked in: ` +
    `RELEASE_WORKFLOW_CONFIG_PATH (${envPath ?? 'unset'}), ${bundled}`,
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
 *   - dependsOn references real stage IDs
 *   - blocks references real stage IDs
 *   - runner names exist in FACTORY_REGISTRY
 *   - sub-step with `runner` MUST also have `editableField`
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

    for (const sub of stage.subSteps) {
      if (subStepIds.has(sub.id)) errors.push(`${stage.id}: duplicate sub-step ID '${sub.id}'`);
      subStepIds.add(sub.id);

      if (sub.runner) {
        if (!FACTORY_REGISTRY[sub.runner]) {
          errors.push(
            `${stage.id}.${sub.id}: unknown runner '${sub.runner}' ` +
            `(available: ${Object.keys(FACTORY_REGISTRY).join(', ')})`,
          );
        }
        if (!sub.editableField) {
          errors.push(
            `${stage.id}.${sub.id}: sub-step has runner '${sub.runner}' but no editableField. ` +
            `Runners need a field to read from.`,
          );
        }
      }
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
  }

  if (errors.length > 0) {
    throw new Error(`Release workflow YAML failed cross-validation:\n  ${errors.join('\n  ')}`);
  }
}

/**
 * Synthesize a check ID from a sub-step ID. Used for both the persisted
 * AutomatedCheck.id and the autoTickedBy reference. Sub-step IDs are unique
 * within a stage, so the resulting check IDs are also unique within a stage.
 */
function synthesizeCheckId(subStepId: string): string {
  return `check-${subStepId}`;
}

/**
 * Build a Stage[] (the canonical template) from validated YAML. For each
 * sub-step with a runner, synthesize a corresponding AutomatedCheck entry
 * and wire the sub-step's autoTickedBy to it.
 */
function buildStageTemplate(workflow: WorkflowYaml): Stage[] {
  return workflow.stages.map((def, idx) => {
    const subSteps = def.subSteps.map((s) => {
      const autoTickedBy = s.runner ? [synthesizeCheckId(s.id)] : [];
      // Resolve placeholder: explicit YAML value wins; otherwise the runner's
      // declared default; otherwise null (the frontend falls back to a generic
      // "Paste value" for manual-only sub-steps without a runner).
      const placeholder =
        s.placeholder ??
        (s.runner ? RUNNER_PLACEHOLDERS[s.runner] ?? null : null);
      // Resolve inputType: explicit YAML value wins; otherwise the runner's
      // declared type; otherwise 'text'.
      const inputType: 'text' | 'textarea' =
        s.inputType ??
        (s.runner ? RUNNER_INPUT_TYPES[s.runner] : undefined) ??
        'text';
      // Resolve helpUrl + helpUrlLabel: both come from YAML; if helpUrl is
      // set but helpUrlLabel isn't, fall back to a generic label so the UI
      // always has something to show.
      const helpUrl = s.helpUrl ?? null;
      const helpUrlLabel = helpUrl ? (s.helpUrlLabel ?? 'Open link') : null;
      return {
        id: s.id,
        label: s.label,
        state: 'unchecked' as const,
        source: null,
        autoTickedBy,
        editableField: s.editableField ?? null,
        inputType,
        track: s.track,
        placeholder,
        helpUrl,
        helpUrlLabel,
        completedAt: null,
        completedBy: null,
      };
    });

    // Synthesize one AutomatedCheck per sub-step that has a runner.
    const automatedChecks = def.subSteps
      .filter((s) => !!s.runner)
      .map((s) => ({
        id: synthesizeCheckId(s.id),
        label: s.label,                      // share the sub-step's label
        status: 'pending' as const,
        lastRunAt: null,
        result: null,
        errorMessage: null,
      }));

    return {
      id: def.id,
      displayOrder: idx + 1,
      name: def.name,
      kind: def.kind as StageKind,
      status: def.initialStatus as StageStatus,
      startedAt: null,
      closedAt: null,
      subSteps,
      automatedChecks,
      notes: [],
      override: null,
      dependsOn: def.dependsOn,
      ...(def.blocks ? { blocks: def.blocks } : {}),
    };
  });
}

/**
 * Build the per-stage runner map by walking sub-steps with a runner and
 * instantiating each runner factory with `{ field: editableField }`.
 *
 * Cross-validation has already confirmed every runner name exists and every
 * sub-step with a runner has an editableField.
 */
function buildStageRunners(workflow: WorkflowYaml): Record<string, StageRunnerMap> {
  const runners: Record<string, StageRunnerMap> = {};

  for (const stage of workflow.stages) {
    const stageMap: StageRunnerMap = {};
    for (const sub of stage.subSteps) {
      if (!sub.runner) continue;

      const factory = FACTORY_REGISTRY[sub.runner] as FactoryFn;
      const checkId = synthesizeCheckId(sub.id);
      try {
        stageMap[checkId] = factory({ field: sub.editableField });
      } catch (err: any) {
        throw new Error(
          `Failed to build runner '${sub.runner}' for ${stage.id}.${sub.id}: ` +
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

const totalSubSteps = workflow.stages.reduce((n, s) => n + s.subSteps.length, 0);
const totalRunners = workflow.stages.reduce(
  (n, s) => n + s.subSteps.filter((sub) => !!sub.runner).length,
  0,
);

console.log(
  `[release-workflow] Validated ${workflow.stages.length} stage(s); ` +
  `${totalSubSteps} sub-step(s); ` +
  `${totalRunners} runner(s) wired`,
);

// ============================================================================
// Exports — same surface as before
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
