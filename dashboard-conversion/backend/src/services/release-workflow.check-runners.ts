/**
 * Release Workflow — stage runners
 *
 * Maps each stage's check IDs to the primitive that runs them. This file is
 * the single source of truth for "which checks are wired" — one glance tells
 * you which stages have working automation and which are still placeholders.
 *
 * The release-workflow.service consumes only STAGE_RUNNERS (the combined
 * map). Per-stage owners add entries here as their checks come online.
 *
 * Conventions:
 *   - A check ID with NO entry in this file simply doesn't run (returns
 *     unchanged, status stays 'pending'). No fabricated data.
 *   - Each entry receives the full Release plus the check object, and
 *     returns a Promise<AutomatedCheck> with status / lastRunAt / result /
 *     errorMessage populated.
 */

import { AutomatedCheck, Release } from '../models/release-workflow.model';
import {
  confluencePageExists,
  jiraFixVersionExists,
  githubPullRequestUrlExists,
  valueIsSet,
} from './release-workflow.check-primitives';

export type CheckRunner = (release: Release, check: AutomatedCheck) => Promise<AutomatedCheck>;
export type StageRunnerMap = Record<string, CheckRunner>;

// ============================================================================
// STAGE 1 — Intake & Setup
// ============================================================================

const STAGE1_RUNNERS: StageRunnerMap = {
  'check-confluence-page-resolves': (release, check) =>
    confluencePageExists(release.metadata.intakePageId, check, { fieldName: 'intakePageId' }),

  'check-self-serve-link-resolves': (release, check) =>
    // intakeSheetUrl is a Confluence URL; extract the page ID from it.
    confluencePageExists(extractConfluencePageId(release.metadata.intakeSheetUrl), check, {
      fieldName: 'intakeSheetUrl',
    }),

  'check-fix-version-exists': (release, check) =>
    jiraFixVersionExists(release.metadata.fixVersion, check),

  'check-intake-page-id-set': (release, check) =>
    valueIsSet(release.metadata.intakePageId, check, { fieldName: 'intakePageId' }),

  'check-env-matrix-pr': (release, check) =>
    githubPullRequestUrlExists(release.metadata.envMatrixPrUrl, check),
};

// ============================================================================
// STAGES 2–10 — placeholders
//
// Each stage's runners go here as they come online. The check IDs are
// already declared in release-workflow.template.ts; per-stage owners just
// fill in the mapping below.
// ============================================================================

const STAGE2_RUNNERS: StageRunnerMap = {
  // 'check-cdb-ui-configs-branch-exists': (release, check) => githubBranchExists(...),
  // 'check-master-jira-exists':            (release, check) => jiraIssueExists(...),
  // 'check-da-subtasks-exist':             (release, check) => jiraSubtasksExist(...),
  // ...
};

const STAGE3_RUNNERS: StageRunnerMap = {
  // 'check-sealights-disable-pr':  (release, check) => githubPullRequestExists(...),
  // 'check-clean-qa-builds':       (release, check) => artifactoryArtifactExists(...),
};

const STAGE4_RUNNERS: StageRunnerMap = {
  // 'check-package-json-version':  (release, check) => githubFileContentMatches(...),
  // 'check-mobile-versions-table': (release, check) => confluencePageExists(...),
  // 'check-mobile-pipelines':      (release, check) => artifactoryArtifactsExist(...),
  // 'check-build-link-reachable':  (release, check) => urlReachable(...),
};

const STAGE5_RUNNERS: StageRunnerMap = {
  // 'check-war-promoted': (release, check) => artifactoryArtifactExists(...),
};

const STAGE6_RUNNERS: StageRunnerMap = {
  // 'check-pre-prod-letter-page':  (release, check) => confluencePageExists(...),
  // 'check-prod-letter-page':      (release, check) => confluencePageExists(...),
  // 'check-jira-subtasks-closed':  (release, check) => jiraSubtasksAllClosed(...),
};

// Stages 7, 8, 10 have no automated checks (manual only) — no runners needed.

const STAGE9_RUNNERS: StageRunnerMap = {
  // 'check-f26-deployments-page':    (release, check) => confluencePageExists(...),
  // 'check-retrofit-cdb-ui-pr':      (release, check) => githubPullRequestExists(...),
  // 'check-retrofit-cdb-configs-pr': (release, check) => githubPullRequestExists(...),
  // 'check-retrofit-freddy-pr':      (release, check) => githubPullRequestExists(...),
  // 'check-repo-tags':               (release, check) => githubTagsExist(...),
};

// ============================================================================
// Combined map — single export consumed by release-workflow.service
// ============================================================================

export const STAGE_RUNNERS: Record<string, StageRunnerMap> = {
  'stage1-intake':              STAGE1_RUNNERS,
  'stage2-branching':           STAGE2_RUNNERS,
  'stage3-build-stabilization': STAGE3_RUNNERS,
  'stage4-mobile-build':        STAGE4_RUNNERS,
  'stage5-war-promotion':       STAGE5_RUNNERS,
  'stage6-doc-prep':            STAGE6_RUNNERS,
  'stage9-post-go-live':        STAGE9_RUNNERS,
  // stage7-pre-prod, stage8-prod, stage10-post-mobile have no API checks
};

// ---------- helpers used above ----------

/**
 * Pull a Confluence page ID out of a typical Confluence URL.
 *   https://confluence.example.com/.../pages/1110606115/...           → "1110606115"
 *   https://confluence.example.com/.../viewpage.action?pageId=12345   → "12345"
 *
 * Returns null if no page ID can be extracted.
 */
function extractConfluencePageId(url: string | null | undefined): string | null {
  if (!url) return null;
  // /pages/{pageId}/... pattern
  const pagesMatch = url.match(/\/pages\/(\d+)(?:\/|$)/);
  if (pagesMatch) return pagesMatch[1];
  // ?pageId=... pattern
  const queryMatch = url.match(/[?&]pageId=(\d+)/);
  if (queryMatch) return queryMatch[1];
  return null;
}
