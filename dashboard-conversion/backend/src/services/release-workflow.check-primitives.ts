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
// The two services below exist in the production CDB Dashboard repo.
// If your method names differ, this is the only file you need to adjust.
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
 * Expected production method:
 *   jiraService.getFixVersionByName(versionName: string): Promise<{ id, name, projectKey?, released? } | null>
 *
 * If your jira.service.ts exposes this differently (e.g. searchVersions(projectKey),
 * getVersions(projectKey), getProjectVersions(projectKey)), replace the call below.
 * If you need to look up versions by project key, source the project key from
 * config or a release metadata field.
 */
export async function jiraFixVersionExists(
  versionName: string | null | undefined,
  check: AutomatedCheck,
): Promise<AutomatedCheck> {
  if (!versionName) {
    return withFailure(check, 'fixVersion is not set on this release');
  }

  try {
    // Adjust this one line if your JIRA service exposes a different shape.
    const version = await (jiraService as any).getFixVersionByName(versionName);
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
 * Expected production method:
 *   jiraService.getIssue(issueKey: string): Promise<{ key, fields: { status, summary, ... } } | null>
 */
export async function jiraIssueExists(
  issueKey: string | null | undefined,
  check: AutomatedCheck,
): Promise<AutomatedCheck> {
  if (!issueKey) {
    return withFailure(check, 'issue key is not set on this release');
  }

  try {
    const issue = await (jiraService as any).getIssue(issueKey);
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
 * Pass if a PR exists in the given repo matching the search criteria.
 *
 * Expected production method:
 *   githubService.searchPullRequests(args: {
 *     repo: string;       // e.g. "owner/env-matrix" or just "env-matrix" depending on your service
 *     query?: string;     // free-text query that narrows by title/body
 *     state?: 'open' | 'closed' | 'all';
 *   }): Promise<Array<{ number, title, state, html_url, ... }>>
 *
 * Pass criteria: at least one PR returned.
 *
 * Adjust the call signature if your githubService exposes search differently.
 */
export async function githubPullRequestExists(
  args: {
    repo: string;
    query: string;          // typically the release ID or branch name
    state?: 'open' | 'closed' | 'all';
  },
  check: AutomatedCheck,
): Promise<AutomatedCheck> {
  const { repo, query, state = 'all' } = args;

  if (!repo || !query) {
    return withFailure(check, 'GitHub PR check is missing repo or query');
  }

  try {
    const prs: any[] = await (githubService as any).searchPullRequests({ repo, query, state });
    if (!Array.isArray(prs) || prs.length === 0) {
      return withFailure(check, `No GitHub PR found in '${repo}' matching '${query}'`);
    }
    const pr = prs[0];
    return withPass(check, {
      prNumber: pr.number,
      title: pr.title ?? null,
      state: pr.state ?? null,
      url: pr.html_url ?? pr.url ?? null,
      matchCount: prs.length,
    });
  } catch (err: any) {
    return withFailure(check, err?.message ?? 'GitHub API call failed');
  }
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
