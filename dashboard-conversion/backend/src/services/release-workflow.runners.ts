/**
 * Release Workflow — runner factory library
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
import artifactoryService from './artifactory.service';
import {
  AutomatedCheck,
  Release,
  ReleaseMetadata,
} from '../models/release-workflow.model';


export type CheckRunner = (release: Release, check: AutomatedCheck) => Promise<AutomatedCheck>;
export type StageRunnerMap = Record<string, CheckRunner>;

type ScalarKey = {
  [K in keyof ReleaseMetadata]: ReleaseMetadata[K] extends string | null ? K : never;
}[keyof ReleaseMetadata];

type BranchKey = keyof ReleaseMetadata['branches'];

export type FieldPath = ScalarKey | `branches.${BranchKey}`;


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
 */
function readField(release: Release, path: FieldPath): string | null {
  if (path.startsWith('branches.')) {
    const branchKey = path.slice('branches.'.length) as BranchKey;
    return release.metadata.branches?.[branchKey] ?? null;
  }
  return release.metadata[path as ScalarKey] ?? null;
}

export function parseConfluencePageIdFromUrl(url: string): string | null {
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

function parseJiraIssueKey(raw: string): string | null {
  const trimmed = raw.trim();
  // /browse/KEY  or  /issues/KEY (anywhere in the URL path)
  const m = trimmed.match(/\/(?:browse|issues)\/([A-Z][A-Z0-9_]+-\d+)/);
  if (m) return m[1];
  // Bare issue key, e.g. SSRELEASE-7001
  if (/^[A-Z][A-Z0-9_]+-\d+$/.test(trimmed)) return trimmed;
  return null;
}

function parseGithubTagUrl(url: string): { owner: string; repo: string; tag: string } | null {
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/releases\/tag\/([^?#]+?)\/?(?:[?#]|$)/);
  if (!m) return null;
  const tag = m[3];
  if (!tag) return null;
  return { owner: m[1], repo: m[2], tag };
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

export function githubTagUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const url = readField(release, field);
    if (!url || !url.trim()) return fail(check, `${field} is not set on this release`);

    const parsed = parseGithubTagUrl(url);
    if (!parsed) return fail(check, `Could not parse owner/repo/tag from URL: ${url}`);

    try {
      const ref: any = await githubService.getTag(parsed.owner, parsed.repo, parsed.tag);
      if (!ref || !ref.ref) return fail(check, `GitHub tag not found: ${parsed.owner}/${parsed.repo}@${parsed.tag}`);
      return pass(check, {
        tagName: parsed.tag,
        owner: parsed.owner,
        repo: parsed.repo,
        sha: ref.object?.sha ?? null,
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

export function jiraTicketUrlCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const raw = readField(release, field);
    if (!raw || !raw.trim()) return fail(check, `${field} is not set on this release`);

    const issueKey = parseJiraIssueKey(raw);
    if (!issueKey) return fail(check, `Could not parse JIRA issue key from: ${raw}`);

    try {
      const issue: any = await jiraService.getIssue(issueKey);
      if (!issue || !issue.key) return fail(check, `JIRA ticket '${issueKey}' not found`);
      return pass(check, {
        key: issue.key,
        summary: issue.fields?.summary ?? null,
        status: issue.fields?.status?.name ?? null,
        url: raw.includes('://') ? raw : null,
      });
    } catch (err: any) {
      const msg = err?.response?.status === 404
        ? `JIRA ticket '${issueKey}' not found (404)`
        : (err?.message ?? 'JIRA API call failed');
      return fail(check, msg);
    }
  };
}

//Valudates a list of Github URLs - Used for dependency jar branch substep
export function githubBranchUrlsMultiCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const raw = readField(release, field);
    if (!raw || !raw.trim()) return fail(check, `${field} is not set on this release`);

    // Split on newlines or commas; drop empties and whitespace.
    const urls = raw
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urls.length === 0) return fail(check, `${field} has no URLs after parsing`);

    const validated: Array<{ url: string; branchName: string; owner: string; repo: string; sha: string | null }> = [];
    const failures: Array<{ url: string; reason: string }> = [];

    for (const url of urls) {
      const parsed = parseGithubBranchUrl(url);
      if (!parsed) {
        failures.push({ url, reason: 'could not parse owner/repo/branch from URL' });
        continue;
      }
      try {
        const branch: any = await githubService.getBranch(parsed.owner, parsed.repo, parsed.branch);
        if (!branch || !branch.name) {
          failures.push({ url, reason: `branch not found: ${parsed.owner}/${parsed.repo}@${parsed.branch}` });
          continue;
        }
        validated.push({
          url,
          branchName: branch.name,
          owner: parsed.owner,
          repo: parsed.repo,
          sha: branch.commit?.sha ?? null,
        });
      } catch (err: any) {
        failures.push({ url, reason: err?.message ?? 'GitHub API call failed' });
      }
    }

    if (failures.length > 0) {
      const total = urls.length;
      const okCount = validated.length;
      // Build a structured result so the UI can render per-URL rows with
      // status icons. The textual errorMessage is still set as a human-
      // readable summary for any consumer that reads only that.
      const lines = failures.map((f) => `  - ${f.url}: ${f.reason}`).join('\n');
      return {
        ...check,
        status: 'failed',
        lastRunAt: nowIso(),
        result: {
          total,
          branches: validated.map((v) => ({
            url: v.url,
            branchName: v.branchName,
            owner: v.owner,
            repo: v.repo,
            ok: true,
          })),
          failures: failures.map((f) => ({
            url: f.url,
            reason: f.reason,
            ok: false,
          })),
        },
        errorMessage: `${okCount}/${total} branches validated; ${failures.length} failed:\n${lines}`,
      };
    }

    return pass(check, {
      total: validated.length,
      branches: validated.map((v) => ({
        url: v.url,
        branchName: v.branchName,
        owner: v.owner,
        repo: v.repo,
        ok: true,
      })),
      failures: [],
    });
  };
}

export function artifactExistsCheck(config: { field: FieldPath }): CheckRunner {
  const { field } = config;
  return async (release, check) => {
    const artifactPath = readField(release, field);
    if (!artifactPath || !artifactPath.trim()) return fail(check, `${field} is not set on this release`);

    try {
      const exists = await artifactoryService.artifactExists(artifactPath.trim());
      return exists
        ? pass(check, { path: artifactPath.trim(), exists: true })
        : fail(check, `Artifact not found in Artifactory: ${artifactPath.trim()}`);
    } catch (err: any) {
      return fail(check, err?.message ?? 'Artifactory API call failed');
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
export type FactoryFn = (config: any) => CheckRunner;

export const FACTORY_REGISTRY: Record<string, FactoryFn> = {
  confluencePageIdCheck,
  confluencePageUrlCheck,
  githubPrUrlCheck,
  githubBranchUrlCheck,
  githubBranchUrlsMultiCheck,
  githubTagUrlCheck,
  jiraFixVersionCheck,
  jiraTicketUrlCheck,
  artifactExistsCheck,
  valueIsSetCheck,
};

export const RUNNER_INPUT_TYPES: Record<string, 'text' | 'textarea'> = {
  githubBranchUrlsMultiCheck: 'textarea',
};

export const RUNNER_PLACEHOLDERS: Record<string, string> = {
  confluencePageIdCheck:  'Paste Confluence page ID, e.g. 1160085900',
  confluencePageUrlCheck: 'Paste Confluence page URL, e.g. https://bmo.atlassian.net/wiki/spaces/.../pages/1234567/...',
  githubPrUrlCheck:       'Paste Pull Request URL, e.g. https://github.com/your-org/repo/pull/123',
  githubBranchUrlCheck:   'Paste GitHub branch URL, e.g. https://github.com/your-org/repo/tree/release/r86.0.0',
  githubBranchUrlsMultiCheck: 'Paste one GitHub branch URL per line\nhttps://github.com/your-org/repo-a/tree/release/r86.0.0\nhttps://github.com/your-org/repo-b/tree/release/r86.0.0',
  githubTagUrlCheck:      'Paste GitHub tag URL, e.g. https://github.com/your-org/repo/releases/tag/v86.0.0',
  jiraTicketUrlCheck:     'Paste JIRA ticket URL, e.g. https://bmo.atlassian.net/browse/SSRELEASE-7001',
  jiraFixVersionCheck:    'Paste JIRA Fix Version name, e.g. R86',
  artifactExistsCheck:    'Paste Artifactory repo path, e.g. cdb-releases-prod/cdbbos/cdbbos-86.0.0.ear',
  valueIsSetCheck:        'Paste value',
};