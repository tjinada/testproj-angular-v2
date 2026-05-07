/**
 * DELETED — DO NOT USE.
 *
 * The template was merged into release-workflow.checks.ts as part of the
 * single-source-of-truth refactor. STAGE_TEMPLATE and cloneStageTemplate
 * are now re-exported from there.
 *
 * Delete this file from the production repo when convenient. The stub here
 * exists only because the dashboard-conversion staging workspace doesn't
 * expose a delete operation; the file is intentionally inert and throws on
 * import.
 */

throw new Error(
  'release-workflow.template.ts is deprecated. ' +
  "Import STAGE_TEMPLATE / cloneStageTemplate from './release-workflow.checks' instead.",
);

export {};
