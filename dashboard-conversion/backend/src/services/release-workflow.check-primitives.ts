/**
 * Release Workflow — check primitives
 *
 * A small library of reusable "check this thing exists" functions, one per
 * (provider, operation) combination. Stage runners call into these
 * primitives; the primitives know nothing about stages or releases.
 *
 * Adding a new provider/operation: add a new exported function here, then
 * wire it from release-workflow.check-runners.ts.
 *
 * Convention: every primitive returns a fully-populated AutomatedCheck
 * (status / lastRunAt / result / errorMessage). They never throw — failures
 * become status: 'failed' with a useful errorMessage.
 */

import confluenceService from './confluence.service';
import jiraService from './jira.service';
import githubService from './github.service';
import { AutomatedCheck } from '../models/release-workflow.model';

// ---------- helpers ----------

function nowIso(): string {
  return new Date().toISOString();
}

function withFailure(check: AutomatedCheck, message: string): AutomatedCheck {
  return {
    ...check,
    status: 'failed',
    lastRunAt: nowIso(),
    result: null,
    errorMessage: message,
  };
}

function withPass(check: AutomatedCheck, result: Record<string, unknown>): AutomatedCheck {
  return {
    ...check,
    status: 'passed',
    lastRunAt: nowIso(),
    result,
    errorMessage: null,
  };
}

// ---------- Confluence ----------

/**
 * Pass if the given Confluence page ID resolves to a real page.
 * Records pageId, title, and webui link in result.
 *
 * Calls confluenceService.getPageContent(pageId), which in production hits
 * GET /content/{pageId}?expand=history,version,body.storage
 */
export async function confluencePageExists(
  pageId: string | null | undefined,
  check: AutomatedCheck,
  context?: { fieldName?: string },
): Promise<AutomatedCheck> {
  if (!pageId) {
    const field = context?.fieldName ?? 'page ID';
    return withFailure(check, `${field} is not set on this release`);
  }

  try {
    const page = await confluenceService.getPageContent(pageId);
    if (!page || !page.id) {
      return withFailure(check, `Confluence page '${pageId}' not found`);
    }
    return withPass(check, {
      pageId: page.id,
      title: page.title ?? '(untitled)',
      webui: page._links?.webui ?? null,
    });
  } catch (err: any) {
    const message = err?.response?.status === 404
      ? `Confluence page '${pageId}' not found (404)`
      : (err?.message ?? 'Confluence API call failed');
    return withFailure(check, message);
  }
}

// ---------- JIRA ----------

/**
 * Pass if the given JIRA fix version exists.
 *
 * Calls jiraService.getFixVersionByName(name) which returns null if not
 * found. The project key is sourced from config.jira.projectKey inside
 * the JIRA service — this primitive doesn't need to know about it.
 */
export async function jiraFixVersionExists(
  versionName: string | null | undefined,
  check: AutomatedCheck,
): Promise<AutomatedCheck> {
  if (!versionName) {
    return withFailure(check, 'fixVersion is not set on this release');
  }

  try {
    const version = await jiraService.getFixVersionByName(versionName);
    if (!version || !version.id) {
      return withFailure(check, `JIRA Fix Version '${versionName}' not found`);
    }
    return withPass(check, {
      id: version.id,
      name: version.name ?? versionName,
      projectKey: version.projectKey ?? null,
      released: version.released ?? null,
    });
  } catch (err: any) {
    const message = err?.response?.status === 404
      ? `JIRA Fix Version '${versionName}' not found (404)`
      : (err?.message ?? 'JIRA API call failed');
    return withFailure(check, message);
  }
}

/**
 * Pass if the given JIRA issue key exists.
 *
 * Calls jiraService.getIssue(key) which returns null if not found.
 */
export async function jiraIssueExists(
  issueKey: string | null | undefined,
  check: AutomatedCheck,
): Promise<AutomatedCheck> {
  if (!issueKey) {
    return withFailure(check, 'issue key is not set on this release');
  }

  try {
    const issue = await jiraService.getIssue(issueKey);
    if (!issue || !issue.key) {
      return withFailure(check, `JIRA issue '${issueKey}' not found`);
    }
    return withPass(check, {
      key: issue.key,
      summary: issue.fields?.summary ?? null,
      status: issue.fields?.status?.name ?? null,
    });
  } catch (err: any) {
    const message = err?.response?.status === 404
      ? `JIRA issue '${issueKey}' not found (404)`
      : (err?.message ?? 'JIRA API call failed');
    return withFailure(check, message);
  }
}

// ---------- GitHub ----------

/**
 * Pass if the given GitHub PR URL resolves to a real PR.
 *
 * Parses owner / repo / number out of the URL, calls
 * githubService.getPullRequest. Records prNumber, title, state, and url
 * in result.
 *
 * Accepts both github.com and Enterprise URLs; the path shape is the
 * same: `.../{owner}/{repo}/pull/{number}`.
 */
export async function githubPullRequestUrlExists(
  prUrl: string | null | undefined,
  check: AutomatedCheck,
): Promise<AutomatedCheck> {
  if (!prUrl || !prUrl.trim()) {
    return withFailure(check, 'PR URL is not set on this release');
  }

  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) {
    return withFailure(check, `Could not parse owner/repo/number from PR URL: ${prUrl}`);
  }

  try {
    const pr = await githubService.getPullRequest(parsed.owner, parsed.repo, parsed.number);
    if (!pr || !pr.number) {
      return withFailure(
        check,
        `GitHub PR not found: ${parsed.owner}/${parsed.repo}#${parsed.number}`,
      );
    }
    return withPass(check, {
      prNumber: pr.number,
      title: pr.title ?? null,
      state: pr.merged_at ? 'merged' : (pr.state ?? null),
      url: pr.html_url ?? prUrl,
    });
  } catch (err: any) {
    return withFailure(check, err?.message ?? 'GitHub API call failed');
  }
}

/**
 * Pull owner, repo, and PR number from a GitHub PR URL.
 *   https://github.com/your-org/env-matrix/pull/1234              → ok
 *   https://github.example.com/your-org/env-matrix/pull/1234/files → ok
 *   anything else                                                  → null
 */
function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  // Tolerate enterprise hostnames and trailing path segments (/files, /commits, etc.)
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const num = parseInt(m[3], 10);
  if (!Number.isFinite(num)) return null;
  return { owner: m[1], repo: m[2], number: num };
}

// ---------- internal / sanity-check primitives ----------

/**
 * Pass if `value` is a non-empty string. Used for "is this metadata field set"
 * style checks where the only validation we can do without a third-party API
 * is "did the user fill it in".
 */
export async function valueIsSet(
  value: string | null | undefined,
  check: AutomatedCheck,
  context?: { fieldName?: string },
): Promise<AutomatedCheck> {
  const field = context?.fieldName ?? 'value';
  if (!value || !value.trim()) {
    return withFailure(check, `${field} is not set on this release`);
  }
  return withPass(check, { [field]: value });
}
