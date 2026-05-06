/**
 * Release Workflow — check result formatters (frontend)
 *
 * One-line summary strings for each automated check ID. The generic
 * stage-view component reads from this map to display passed-check details
 * without needing to know anything about specific check IDs.
 *
 * Adding a new check ID:
 *   - If the result shape has nothing interesting to surface, omit the entry
 *     entirely; the default formatter ('Passed') is fine.
 *   - Otherwise, add `'check-id': (result) => '...'` below.
 *
 * The check's `result` field is whatever the backend primitive populated.
 * See backend/src/services/release-workflow.check-primitives.ts for the
 * shapes returned by each primitive.
 */

export type CheckResultFormatter = (result: any) => string;

export const CHECK_RESULT_FORMATTERS: Record<string, CheckResultFormatter> = {
  // Confluence primitive returns: { pageId, title, webui }
  'check-confluence-page-resolves': (r) => r?.title ? `Page found: ${r.title}` : 'Passed',
  'check-self-serve-link-resolves': (r) => r?.title ? `Page found: ${r.title}` : 'Passed',
  'check-pre-prod-letter-page':     (r) => r?.title ? `Page found: ${r.title}` : 'Passed',
  'check-prod-letter-page':         (r) => r?.title ? `Page found: ${r.title}` : 'Passed',
  'check-f26-deployments-page':     (r) => r?.title ? `Page found: ${r.title}` : 'Passed',
  'check-mobile-versions-table':    (r) => r?.title ? `Page found: ${r.title}` : 'Passed',

  // JIRA fix-version primitive returns: { id, name, projectKey, released }
  'check-fix-version-exists': (r) => r?.name ? `Fix Version: ${r.name}` : 'Passed',

  // JIRA issue primitive returns: { key, summary, status }
  'check-master-jira-exists': (r) =>
    r?.key ? `${r.key}${r.status ? ' (' + r.status + ')' : ''}` : 'Passed',

  // valueIsSet primitive returns: { [fieldName]: value }
  'check-intake-page-id-set': (r) => r?.intakePageId ? `Set: ${r.intakePageId}` : 'Passed',

  // GitHub PR primitive returns: { prNumber, title, state, url, matchCount }
  'check-env-matrix-pr':           (r) => r?.prNumber ? `PR #${r.prNumber} (${r.state})` : 'Passed',
  'check-sealights-disable-pr':    (r) => r?.prNumber ? `PR #${r.prNumber} (${r.state})` : 'Passed',
  'check-retrofit-cdb-ui-pr':      (r) => r?.prNumber ? `PR #${r.prNumber} (${r.state})` : 'Passed',
  'check-retrofit-cdb-configs-pr': (r) => r?.prNumber ? `PR #${r.prNumber} (${r.state})` : 'Passed',
  'check-retrofit-freddy-pr':      (r) => r?.prNumber ? `PR #${r.prNumber} (${r.state})` : 'Passed',
};

/**
 * Get the display string for a check given its current state.
 * Handles non-passed statuses (failed/pending/running) before falling
 * through to the per-check formatter.
 */
export function formatCheckResult(check: {
  id: string;
  status: string;
  result: any;
  errorMessage: string | null;
}): string {
  if (check.status === 'failed')  return check.errorMessage ?? 'Failed';
  if (check.status === 'pending') return 'Not yet run';
  if (check.status === 'running') return 'Running…';

  const formatter = CHECK_RESULT_FORMATTERS[check.id];
  if (formatter) {
    try {
      return formatter(check.result);
    } catch {
      return 'Passed';
    }
  }
  return 'Passed';
}
