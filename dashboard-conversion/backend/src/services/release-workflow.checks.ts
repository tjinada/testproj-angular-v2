/**
 * Release Workflow — checks
 *
 * One file. One small library of pattern factories at the top, one entry per
 * check ID in STAGE_RUNNERS at the bottom.
 *
 * Most checks fit a known pattern (resolve a Confluence page, resolve a
 * GitHub PR URL, validate a JIRA fix version, etc.) and become one-line
 * registrations using a factory. Checks that don't fit any pattern get
 * written longhand as a regular async function.
 *
 * Adding a check that fits a pattern: add a line to STAGE_RUNNERS.
 * Adding a check that doesn't fit a pattern: write a function above
 *   STAGE_RUNNERS, then register it.
 * Adding a new pattern that more than one stage will use: add a new factory
 *   above STAGE_RUNNERS.
 *
 * Result-shape conventions (frontend formatters detect by shape):
 *   - Confluence page  → { pageId, title, webui }
 *   - JIRA fix version → { id, name, projectKey, released }
 *   - JIRA issue       → { key, summary, status }
 *   - GitHub PR        → { prNumber, title, state, url }
 *   - valueIsSet       → { [fieldName]: value }
 */

import confluenceService from './confluence.service';
import jiraService from './jira.service';
import githubService from './github.service';
import { AutomatedCheck, Release, ReleaseMetadata } from '../models/release-workflow.model';

// ============================================================================
// Types
// ============================================================================

export type CheckRunner = (release: Release, check: AutomatedCheck) => Promise<AutomatedCheck>;
export type StageRunnerMap = Record<string, CheckRunner>;

/**
 * Top-level metadata fields that a factory can read. Constrained to the
 * primitives (string/null) on ReleaseMetadata — nested paths like
 * `branches.cdbUi` aren't supported here. If you need a nested field, write
 * the check longhand.
 */
type ScalarMetadataField = {
  [K in keyof ReleaseMetadata]: ReleaseMetadata[K] extends string | null ? K : never;
}[keyof ReleaseMetadata];

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
 * Pull a Confluence page ID from a typical Confluence URL.
 *   .../pages/1110606115/...                        → "1110606115"
 *   .../viewpage.action?pageId=1110606115           → "1110606115"
 *   anything else                                   → null
 */
function parseConfluencePageIdFromUrl(url: string): string | null {
  const pages = url.match(/\/pages\/(\d+)(?:\/|$)/);
  if (pages) return pages[1];
  const query = url.match(/[?&]pageId=(\d+)/);
  if (query) return query[1];
  return null;
}

/**
 * Pull owner / repo / number from a GitHub PR URL.
 *   https://github.com/your-org/env-matrix/pull/1234   → ok
 *   https://github.example.com/org/repo/pull/42/files  → ok
 *   anything else                                      → null
 */
function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const num = parseInt(m[3], 10);
  if (!Number.isFinite(num)) return null;
  return { owner: m[1], repo: m[2], number: num };
}

// ============================================================================
// Pattern factories — the reusable check library
//
// Each factory takes a small config and returns a CheckRunner. Stage owners
// register these directly in STAGE_RUNNERS; no per-stage function needed for
// the common patterns.
// ============================================================================

/**
 * Pass if the configured Confluence page ID resolves.
 *
 * If `isUrl: true`, the field's value is treated as a Confluence URL and the
 * page ID is parsed out before resolving.
 */
export function confluencePageCheck(config: {
  field: ScalarMetadataField;
  isUrl?: boolean;
}): CheckRunner {
  const { field, isUrl } = config;

  return async (release, check) => {
    const raw = release.metadata[field];
    if (!raw || !raw.trim()) {
      return fail(check, `${field} is not set on this release`);
    }

    const pageId = isUrl ? parseConfluencePageIdFromUrl(raw) : raw;
    if (!pageId) {
      return fail(check, `Could not parse pageId from ${field}: ${raw}`);
    }

    try {
      const page: any = await confluenceService.getPageContent(pageId);
      if (!page || !page.id) {
        return fail(check, `Confluence page '${pageId}' not found`);
      }
      return pass(check, {
        pageId: page.id,
        title: page.title ?? '(untitled)',
        webui: page._links?.webui ?? null,
      });
    } catch (err: any) {
      const message = err?.response?.status === 404
        ? `Confluence page '${pageId}' not found (404)`
        : (err?.message ?? 'Confluence API call failed');
      return fail(check, message);
    }
  };
}

/**
 * Pass if the configured field holds a GitHub PR URL that resolves to a real PR.
 *
 * Parses owner / repo / number from the URL, then fetches the PR. Works for
 * both github.com and Enterprise URLs.
 */
export function githubPrUrlCheck(config: { field: ScalarMetadataField }): CheckRunner {
  const { field } = config;

  return async (release, check) => {
    const url = release.metadata[field];
    if (!url || !url.trim()) {
      return fail(check, `${field} is not set on this release`);
    }

    const parsed = parseGithubPrUrl(url);
    if (!parsed) {
      return fail(check, `Could not parse owner/repo/number from PR URL: ${url}`);
    }

    try {
      const pr: any = await githubService.getPullRequest(parsed.owner, parsed.repo, parsed.number);
      if (!pr || !pr.number) {
        return fail(check, `GitHub PR not found: ${parsed.owner}/${parsed.repo}#${parsed.number}`);
      }
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

/**
 * Pass if the configured JIRA fix version exists in the configured project.
 *
 * Project key is sourced from config.jira.projectKey inside jira.service.ts.
 */
export function jiraFixVersionCheck(config: { field: ScalarMetadataField }): CheckRunner {
  const { field } = config;

  return async (release, check) => {
    const versionName = release.metadata[field];
    if (!versionName || !versionName.trim()) {
      return fail(check, `${field} is not set on this release`);
    }

    try {
      const version: any = await jiraService.getFixVersionByName(versionName);
      if (!version || !version.id) {
        return fail(check, `JIRA Fix Version '${versionName}' not found`);
      }
      return pass(check, {
        id: version.id,
        name: version.name ?? versionName,
        projectKey: version.projectKey ?? null,
        released: version.released ?? null,
      });
    } catch (err: any) {
      const message = err?.response?.status === 404
        ? `JIRA Fix Version '${versionName}' not found (404)`
        : (err?.message ?? 'JIRA API call failed');
      return fail(check, message);
    }
  };
}

/**
 * Pure local check: pass if the configured metadata field is non-empty.
 *
 * No API call. Useful for sanity-checking that the sheriff filled in a field
 * during intake. The success result includes the field's value.
 */
export function valueIsSetCheck(config: { field: ScalarMetadataField }): CheckRunner {
  const { field } = config;

  return async (release, check) => {
    const value = release.metadata[field];
    return value && value.trim()
      ? pass(check, { [field]: value })
      : fail(check, `${field} is not set on this release`);
  };
}

// ============================================================================
// Custom (non-pattern) checks
//
// Checks that don't fit any factory live as standalone functions here.
// Stage 1 has none today; this section is empty.
// ============================================================================

// (none yet)

// ============================================================================
// Registration — single source of truth for which checks are wired
// ============================================================================

export const STAGE_RUNNERS: Record<string, StageRunnerMap> = {
  'stage1-intake': {
    'check-confluence-page-resolves': confluencePageCheck({ field: 'intakePageId' }),
    'check-self-serve-link-resolves': confluencePageCheck({ field: 'intakeSheetUrl', isUrl: true }),
    'check-fix-version-exists':       jiraFixVersionCheck({ field: 'fixVersion' }),
    'check-intake-page-id-set':       valueIsSetCheck({ field: 'intakePageId' }),
    'check-env-matrix-pr':            githubPrUrlCheck({ field: 'envMatrixPrUrl' }),
  },

  // Stages 2-9 owners: add your stage's runners here. Reuse the factories
  // above where possible; write longhand functions in the section above
  // for genuinely custom checks.
  //
  // 'stage2-branching':           { /* ... */ },
  // 'stage3-build-stabilization': { /* ... */ },
  // 'stage4-mobile-build':        { /* ... */ },
  // 'stage5-war-promotion':       { /* ... */ },
  // 'stage6-doc-prep':            { /* ... */ },
  // 'stage9-post-go-live':        { /* ... */ },
  //
  // Stages 7, 8, 10 are manual-only — no automated checks.
};
