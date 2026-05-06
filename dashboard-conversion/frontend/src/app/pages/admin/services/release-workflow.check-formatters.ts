/**
 * DELETED — DO NOT USE.
 *
 * Check result formatting moved to:
 *   components/release-workflow-section/stage-view/check-result-display.ts
 *
 * It's now keyed by result shape (5 entries) instead of check ID, so it
 * doesn't grow as new checks are wired. Co-located with stage-view because
 * that's the only consumer.
 *
 * Delete this file from the production repo when convenient. The dashboard-
 * conversion staging workspace doesn't expose a delete operation; this stub
 * is intentionally inert and throws on import to flag any straggler imports.
 */

throw new Error(
  'release-workflow.check-formatters.ts is deprecated. ' +
  "Use formatCheckResult from '.../stage-view/check-result-display' instead.",
);

export {};
