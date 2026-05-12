/**
 * Release Workflow — runner factory library
 *
 * The pattern factories that workflow YAML references by name. Each factory
 * takes a config object and returns a CheckRunner.
 *
 * To add a new factory:
 *   1. Implement an `export function fooCheck(config: { ... }): CheckRunner`
 *      below
 *   2. Register it in FACTORY_REGISTRY at the bottom of this file
 *   3. Reference it from YAML as `runner: fooCheck`
 *
 * Result-shape conventions (frontend formatters detect by shape):
 *   Confluence page  → { pageId, title, webui }
 *   JIRA fix version → { id, name, projectKey, released }
 *   JIRA issue       → { key, summary, status }
 *   GitHub PR        → { prNumber, title, state, url }
 *   GitHub branch    → { branchName, owner, repo, sha }
 *   valueIsSet       → { [fieldName]: value }
 */

import confluenceService from './confluence.service';
import jiraService from './jira.service';
import githubService from './github.service';
import {
  AutomatedCheck,
  Release,
  ReleaseMetadata,
} from '../models/release-workflow.model';

// ============================================================================
// Types — exported for the loader and the rest of the app
// ============================================================================

export type CheckRunner = (release: Release, check: AutomatedCheck) => Promise<AutomatedCheck>;
export type StageRunnerMap = Record<string, CheckRunner>;

/**
 * Allowed metadata field paths that runners can read.
 *
 * - Top-level scalar fields on ReleaseMetadata (string | null), e.g.
 *   'intakePageId', 'fixVersion'.
 * - Nested branches paths, e.g. 'branches.cdbUi'.
 *
 * The union is derived from the model so renaming a field flags every
 * call site that referenced it.
 */
type ScalarKey = {
  [K in keyof ReleaseMetadata]: ReleaseMetadata[K] extends string | null ? K : never;
}[keyof ReleaseMetadata];

type BranchKey = keyof ReleaseMetadata['branches'];

export type FieldPath = ScalarKey | `branches.${BranchKey}`;

// ============================================================================
// Helpers
// ============================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function pass(check: AutomatedCheck, result: Record<string, unknown>): AutomatedCheck {
  return { ...check, status: 'passed', lastRunAt: nowIso(), result, errorMessage: null };
}

function fail(check: AutomatedCheck, message: string): AutomatedCheck {
  return { ...check, status: 'failed', lastRunAt: nowIso(), result: null, errorMessage: message };
}

/**
 * Read the value at `path` on a release's metadata.
 *
 * Top-level scalar field ('intakePageId') or single-level nested path under
 * branches ('branches.cdbUi'). Returns null if anything is missing.
 */
function readField(release: Release, path: FieldPath): string | null {
  if (path.startsWith('branches.')) {
    const branchKey = path.slice('branches.'.length) as BranchKey;
    return release.metadata.branches?.[branchKey] ?? null;
  }
  return release.metadata[path as ScalarKey] ?? null;
}

function parseConfluencePageIdFromUrl(url: string): string | null {
  const pages = url.match(/\/pages\/(\d+)(?:\/|$)/);
  if (pages) return pages[1];
  const query = url.match(/[?&]pageId=(\d+)/);
  if (query) return query[1];
  return null;
}

function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const num = parseInt(m[3], 10);
  if (!Number.isFinite(num)) return null;
  return { owner: m[1], repo: m[2], number: num };
}

function parseGithubBranchUrl(url: string): { owner: string; repo: string; branch: string } | null {
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/tree\/([^?#]+?)\/?(?:[?#]|$)/);
  if (!m) return null;
  const branch = m[3];
  if (!branch) return null;
  return { owner: m[1], repo: m[2], branch };
}

// ============================================================================
// Factories — referenced from YAML by their function name
// ============================================================================

/**
 * Pass if the configured field holds a Confluence page ID that resolves.
 * The field value is treated as the page ID directly.
 */
export function confluencePageIdCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const pageId = readField(release, field);
    if (!pageId || !pageId.trim()) return fail(check, `${field} is not set on this release`);

    try {
      const page: any = await confluenceService.getPageContent(pageId);
      if (!page || !page.id) return fail(check, `Confluence page '${pageId}' not found`);
      return pass(check, {
        pageId: page.id,
        title: page.title ?? '(untitled)',
        webui: page._links?.webui ?? null,
      });
    } catch (err: any) {
      const msg = err?.response?.status === 404
        ? `Confluence page '${pageId}' not found (404)`
        : (err?.message ?? 'Confluence API call failed');
      return fail(check, msg);
    }
  };
}

/**
 * Pass if the configured field holds a Confluence page URL that resolves.
 * The field value is parsed for a page ID.
 */
export function confluencePageUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const url = readField(release, field);
    if (!url || !url.trim()) return fail(check, `${field} is not set on this release`);

    const pageId = parseConfluencePageIdFromUrl(url);
    if (!pageId) return fail(check, `Could not parse pageId from URL: ${url}`);

    try {
      const page: any = await confluenceService.getPageContent(pageId);
      if (!page || !page.id) return fail(check, `Confluence page '${pageId}' not found`);
      return pass(check, {
        pageId: page.id,
        title: page.title ?? '(untitled)',
        webui: page._links?.webui ?? null,
      });
    } catch (err: any) {
      const msg = err?.response?.status === 404
        ? `Confluence page '${pageId}' not found (404)`
        : (err?.message ?? 'Confluence API call failed');
      return fail(check, msg);
    }
  };
}

export function githubPrUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const url = readField(release, field);
    if (!url || !url.trim()) return fail(check, `${field} is not set on this release`);

    const parsed = parseGithubPrUrl(url);
    if (!parsed) return fail(check, `Could not parse owner/repo/number from PR URL: ${url}`);

    try {
      const pr: any = await githubService.getPullRequest(parsed.owner, parsed.repo, parsed.number);
      if (!pr || !pr.number) return fail(check, `GitHub PR not found: ${parsed.owner}/${parsed.repo}#${parsed.number}`);
      return pass(check, {
        prNumber: pr.number,
        title: pr.title ?? null,
        state: pr.merged_at ? 'merged' : (pr.state ?? null),
        url: pr.html_url ?? url,
      });
    } catch (err: any) {
      return fail(check, err?.message ?? 'GitHub API call failed');
    }
  };
}

export function githubBranchUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const url = readField(release, field);
    if (!url || !url.trim()) return fail(check, `${field} is not set on this release`);

    const parsed = parseGithubBranchUrl(url);
    if (!parsed) return fail(check, `Could not parse owner/repo/branch from URL: ${url}`);

    try {
      const branch: any = await githubService.getBranch(parsed.owner, parsed.repo, parsed.branch);
      if (!branch || !branch.name) return fail(check, `GitHub branch not found: ${parsed.owner}/${parsed.repo}@${parsed.branch}`);
      return pass(check, {
        branchName: branch.name,
        owner: parsed.owner,
        repo: parsed.repo,
        sha: branch.commit?.sha ?? null,
      });
    } catch (err: any) {
      return fail(check, err?.message ?? 'GitHub API call failed');
    }
  };
}

export function jiraFixVersionCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const versionName = readField(release, field);
    if (!versionName || !versionName.trim()) return fail(check, `${field} is not set on this release`);

    try {
      const version: any = await jiraService.getFixVersionByName(versionName);
      if (!version || !version.id) return fail(check, `JIRA Fix Version '${versionName}' not found`);
      return pass(check, {
        id: version.id,
        name: version.name ?? versionName,
        projectKey: version.projectKey ?? null,
        released: version.released ?? null,
      });
    } catch (err: any) {
      const msg = err?.response?.status === 404
        ? `JIRA Fix Version '${versionName}' not found (404)`
        : (err?.message ?? 'JIRA API call failed');
      return fail(check, msg);
    }
  };
}

export function valueIsSetCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const value = readField(release, field);
    return value && value.trim()
      ? pass(check, { [field]: value })
      : fail(check, `${field} is not set on this release`);
  };
}

// ============================================================================
// Factory registry — name → factory function
//
// The loader uses this to resolve `runner: fooCheck` strings in YAML to
// real factory functions. Keep entries in sync as new factories are added.
// ============================================================================

export type FactoryFn = (config: any) => CheckRunner;

export const FACTORY_REGISTRY: Record<string, FactoryFn> = {
  confluencePageIdCheck,
  confluencePageUrlCheck,
  githubPrUrlCheck,
  githubBranchUrlCheck,
  jiraFixVersionCheck,
  valueIsSetCheck,
};

/**
 * Default placeholder text shown in the inline edit input when a sub-step
 * with this runner is being edited. Sub-steps can override this via
 * `placeholder:` in YAML; if no override is set, this is what shows.
 *
 * Keep keys in sync with FACTORY_REGISTRY above. The loader looks up by
 * runner name to fill in the default when YAML doesn't specify one.
 */
export const RUNNER_PLACEHOLDERS: Record<string, string> = {
  confluencePageIdCheck:  'Paste Confluence page ID, e.g. 1160085900',
  confluencePageUrlCheck: 'Paste Confluence page URL, e.g. https://bmo.atlassian.net/wiki/spaces/.../pages/1234567/...',
  githubPrUrlCheck:       'Paste Pull Request URL, e.g. https://github.com/your-org/repo/pull/123',
  githubBranchUrlCheck:   'Paste GitHub branch URL, e.g. https://github.com/your-org/repo/tree/release/r86.0.0',
  jiraFixVersionCheck:    'Paste JIRA Fix Version name, e.g. R86.0.0-103052',
  valueIsSetCheck:        'Paste value',
};
