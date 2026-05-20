/**
 * Check result display
 *
 * Turns a check's free-form `result` JSON into a one-line string for the UI.
 *
 * Keyed by *result shape*, not by check ID. The shape is detected from which
 * fields are present on the result object — which is determined by the
 * backend primitive that produced it (see release-workflow.check-primitives.ts).
 *
 *   confluencePageExists      → { pageId, title, webui }            → "Page found: <title>"
 *   jiraFixVersionExists      → { id, name, projectKey, released }  → "Fix Version: <name>"
 *   jiraIssueExists           → { key, summary, status }            → "<key> (<status>)"
 *   githubPullRequestExists   → { prNumber, title, state, url }     → "PR #<n> (<state>)"
 *   valueIsSet                → { [fieldName]: value }              → "Set: <value>"
 *
 * Adding a new primitive: add one entry below.
 * Adding a new check that reuses an existing primitive: nothing to do.
 *
 * If a result doesn't match any known shape we fall back to "Passed".
 */

type ResultObject = Record<string, unknown> | null | undefined;

interface ShapeFormatter {
  /** Returns true if this formatter knows how to render the given result. */
  matches: (r: ResultObject) => boolean;
  /** Builds the display string from a matching result. */
  render: (r: ResultObject) => string;
}

const SHAPE_FORMATTERS: ShapeFormatter[] = [
  // Confluence page (pageId + title)
  {
    matches: (r) => has(r, 'pageId') && has(r, 'title'),
    render:  (r) => `Page found: ${str(r, 'title') || '(untitled)'}`,
  },

  // JIRA fix version (name + projectKey OR released flag distinguishes from issue)
  {
    matches: (r) => has(r, 'name') && (has(r, 'projectKey') || has(r, 'released') || has(r, 'id')),
    render:  (r) => `Fix Version: ${str(r, 'name')}`,
  },

  // JIRA issue (key + summary or status)
  {
    matches: (r) => has(r, 'key') && (has(r, 'summary') || has(r, 'status')),
    render:  (r) => {
      const key = str(r, 'key');
      const status = str(r, 'status');
      return status ? `${key} (${status})` : key;
    },
  },

  // GitHub PR (prNumber)
  {
    matches: (r) => has(r, 'prNumber'),
    render:  (r) => {
      const num = str(r, 'prNumber');
      const state = str(r, 'state');
      return state ? `PR #${num} (${state})` : `PR #${num}`;
    },
  },

  // GitHub branch (branchName + owner/repo)
  {
    matches: (r) => has(r, 'branchName'),
    render:  (r) => `Branch found: ${str(r, 'branchName')}`,
  },

  // GitHub tag (tagName + owner/repo)
  {
    matches: (r) => has(r, 'tagName'),
    render:  (r) => `Tag found: ${str(r, 'tagName')}`,
  },

  // GitHub branches multi-URL (total + branches array). All validated.
  {
    matches: (r) => has(r, 'total') && has(r, 'branches'),
    render:  (r) => {
      const total = str(r, 'total');
      return `${total}/${total} branches validated`;
    },
  },

  // valueIsSet — single-key result. Last in the list because it's the loosest match.
  {
    matches: (r) => isPlainObject(r) && Object.keys(r as object).length === 1,
    render:  (r) => {
      const key = Object.keys(r as object)[0];
      return `Set: ${(r as Record<string, unknown>)[key]}`;
    },
  },
];

/**
 * Build a display string for a check given its current state.
 * Handles non-passed statuses (failed/pending/running) before falling
 * through to result-shape detection.
 */
export function formatCheckResult(check: {
  status: string;
  result: any;
  errorMessage: string | null;
}): string {
  if (check.status === 'failed')  return check.errorMessage ?? 'Failed';
  if (check.status === 'pending') return 'Not yet run';
  if (check.status === 'running') return 'Running…';

  const result = check.result as ResultObject;
  for (const fmt of SHAPE_FORMATTERS) {
    if (fmt.matches(result)) {
      try {
        return fmt.render(result);
      } catch {
        return 'Passed';
      }
    }
  }
  return 'Passed';
}

// ---------- helpers ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function has(r: ResultObject, key: string): boolean {
  return isPlainObject(r) && r[key] !== undefined && r[key] !== null;
}

function str(r: ResultObject, key: string): string {
  if (!isPlainObject(r)) return '';
  const v = r[key];
  return v == null ? '' : String(v);
}
