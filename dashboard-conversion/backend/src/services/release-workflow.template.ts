/**
 * Release Workflow — stage template
 *
 * Defines the canonical 10-stage structure used to seed every new release.
 * Sub-step IDs and automated-check IDs are STABLE — per-stage owners wire
 * their logic against these IDs without inventing new ones.
 *
 * service.add() clones this template, then sets startedAt/closedAt/etc.
 */

import { Stage, SubStep, AutomatedCheck } from '../models/release-workflow.model';

// ===== helpers =====

function manualSubStep(id: string, label: string): SubStep {
  return {
    id,
    label,
    state: 'unchecked',
    source: null,
    autoTickedBy: [],
    completedAt: null,
    completedBy: null,
  };
}

function autoSubStep(id: string, label: string, autoTickedBy: string[]): SubStep {
  return {
    id,
    label,
    state: 'unchecked',
    source: null,
    autoTickedBy,
    completedAt: null,
    completedBy: null,
  };
}

function check(id: string, label: string, source: AutomatedCheck['source']): AutomatedCheck {
  return {
    id,
    label,
    source,
    status: 'pending',
    lastRunAt: null,
    result: null,
    errorMessage: null,
  };
}

// ===== template =====

export const STAGE_TEMPLATE: Stage[] = [
  // ============================================================
  // STAGE 1 — Intake & Setup
  // ============================================================
  {
    id: 'stage1-intake',
    displayOrder: 1,
    name: 'Intake & Setup',
    kind: 'sequential',
    status: 'ready',                             // first stage starts ready, not locked
    startedAt: null,
    closedAt: null,
    subSteps: [
      autoSubStep('add-confluence-page-link',     'Add Release Confluence page link',                ['check-confluence-page-resolves']),
      autoSubStep('confirm-env-allocation',       'Confirm env allocation (Self Serve link)',         ['check-self-serve-link-resolves']),
      autoSubStep('create-fix-version',           'Create Fix Version in JIRA',                       ['check-fix-version-exists']),
      autoSubStep('add-intake-checklist-page-id', 'Add Intake Checklist Page ID in Admin Portal',     ['check-intake-page-id-set']),
      autoSubStep('raise-env-matrix-pr',          'Raise PR to onboard branch on Env Matrix',         ['check-env-matrix-pr']),
    ],
    automatedChecks: [
      check('check-confluence-page-resolves', 'Confluence API: validate Release page link resolves',  'confluence'),
      check('check-self-serve-link-resolves', 'Confluence API: validate Self Serve env link resolves','confluence'),
      check('check-fix-version-exists',       'JIRA API: confirm Fix Version exists',                 'jira'),
      check('check-intake-page-id-set',       'Internal: validate Checklist Page ID in Admin Portal', 'jira'),
      check('check-env-matrix-pr',            'GitHub API: confirm Env Matrix onboarding PR exists',  'github'),
    ],
    notes: [],
    override: null,
    dependsOn: [],
  },

  // ============================================================
  // STAGE 2 — Branching & Configs (T-14)
  // ============================================================
  {
    id: 'stage2-branching',
    displayOrder: 2,
    name: 'Branching & Configs (T-14)',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      autoSubStep('create-cdb-ui-configs-branch', 'Create CDB UI Configs branch off master',         ['check-cdb-ui-configs-branch-exists']),
      autoSubStep('email-adms',                   'Email ADMs/devs from Scope Intake',                ['check-adm-email-sent']),
      autoSubStep('open-master-jira',             'Open master JIRA "CDB UI Configs - RXX"',          ['check-master-jira-exists']),
      autoSubStep('add-da-team-subtasks',         'Add subtasks per DA team',                         ['check-da-subtasks-exist']),
      autoSubStep('run-configs-report',           'Run CDB_Release_Configs_Report in QA Signoff env', ['check-configs-report-run']),
    ],
    automatedChecks: [
      check('check-cdb-ui-configs-branch-exists', 'GitHub API: CDB UI Configs branch exists off master',  'github'),
      check('check-adm-email-sent',               'Email service: standardized ADM email sent',            'jira'),       // tracked via JIRA comment for now
      check('check-master-jira-exists',           'JIRA API: master "CDB UI Configs - RXX" ticket created','jira'),
      check('check-da-subtasks-exist',            'JIRA API: subtasks exist per DA team',                  'jira'),
      check('check-configs-report-run',           'CDB_Release_Configs_Report run completed',              'artifactory'),
    ],
    notes: [],
    override: null,
    dependsOn: ['stage1-intake'],
  },

  // ============================================================
  // STAGE 3 — Build Stabilization (T-7)
  // ============================================================
  {
    id: 'stage3-build-stabilization',
    displayOrder: 3,
    name: 'Build Stabilization (T-7)',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      manualSubStep('coordinate-platform-qa-go-no-go', 'Coordinate with Platform QA on stable commit'),
      autoSubStep('disable-sealights-pr',              'Disable Sealights via config PR',           ['check-sealights-disable-pr']),
      manualSubStep('run-automated-build-pipeline',    'Run Automated Build Pipeline post-toggle'),
      autoSubStep('confirm-clean-qa-builds',           'Confirm clean QA deployment builds generated', ['check-clean-qa-builds']),
    ],
    automatedChecks: [
      check('check-sealights-disable-pr', 'GitHub API: Sealights-disable PR merged',                            'github'),
      check('check-clean-qa-builds',      'Build artifact check: clean QA builds present at expected location','artifactory'),
    ],
    notes: [],
    override: null,
    dependsOn: ['stage2-branching'],
  },

  // ============================================================
  // STAGE 4 — Mobile Build & Distribution (T-5 to T-4)
  // ============================================================
  {
    id: 'stage4-mobile-build',
    displayOrder: 4,
    name: 'Mobile Build & Distribution (T-5 to T-4)',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      autoSubStep('confirm-package-json-version',  'Confirm package.json version (PROD 0/3/6, Blue 1/4/7, Green 2/5/8)', ['check-package-json-version']),
      autoSubStep('update-mobile-versions-table',  'Update Mobile App Versions Table',                  ['check-mobile-versions-table']),
      manualSubStep('run-blue-mobile-build',       'Run CDB_PROD_Blue_Mobile_Build_Publish'),
      manualSubStep('run-green-mobile-build',      'Run CDB_PROD_Green_Mobile_Build_Publish'),
      manualSubStep('run-prod-mobile-build',       'Run CDB_PROD_Mobile_Build_Publish'),
      manualSubStep('upload-ios-pre-prod',         'Upload iOS Pre-PROD → TestFlight'),
      manualSubStep('share-android-pre-prod-path', 'Share Android Pre-PROD build path'),
      manualSubStep('distribute-prod-builds',      'Distribute PROD Android + iOS builds'),
      manualSubStep('share-build-links',           'Share Mobile App Build Links with Release Mgmt'),
    ],
    automatedChecks: [
      check('check-package-json-version',  'GitHub API: package.json version matches release ending',    'github'),
      check('check-mobile-versions-table', 'Confluence API: Mobile App Versions Table updated',          'confluence'),
      check('check-mobile-pipelines',      'Mobile pipelines (Blue/Green/PROD)',                         'artifactory'),
      check('check-build-link-reachable',  'Build link validation: Pre-PROD + PROD build URLs reachable','artifactory'),
    ],
    notes: [],
    override: null,
    dependsOn: ['stage3-build-stabilization'],
  },

  // ============================================================
  // STAGE 5 — WAR Promotion (T-4 to T-3)
  // ============================================================
  {
    id: 'stage5-war-promotion',
    displayOrder: 5,
    name: 'WAR Promotion (T-4 to T-3)',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      autoSubStep('promote-war-azure', 'Promote WAR via Azure pipeline (definitionId=8398)', ['check-war-promoted']),
    ],
    automatedChecks: [
      check('check-war-promoted', 'Artifactory: promoted WAR file present in PROD path', 'artifactory'),
    ],
    notes: [],
    override: null,
    dependsOn: ['stage4-mobile-build'],
  },

  // ============================================================
  // STAGE 6 — Documentation Prep (parallel)
  // ============================================================
  {
    id: 'stage6-doc-prep',
    displayOrder: 6,
    name: 'Documentation Prep',
    kind: 'parallel',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      autoSubStep('draft-pre-prod-letter', 'Draft Pre-PROD delivery letter',                     ['check-pre-prod-letter-page']),
      autoSubStep('draft-prod-letter',     'Draft PROD delivery letter',                         ['check-prod-letter-page']),
      autoSubStep('close-jira-subtasks',   'Close JIRA subtasks + master ticket for UI Configs', ['check-jira-subtasks-closed']),
    ],
    automatedChecks: [
      check('check-pre-prod-letter-page', 'Confluence API: Pre-PROD delivery letter page exists',    'confluence'),
      check('check-prod-letter-page',     'Confluence API: PROD delivery letter page exists',        'confluence'),
      check('check-jira-subtasks-closed', 'JIRA API: master ticket + all subtasks in Closed status', 'jira'),
    ],
    notes: [],
    override: null,
    dependsOn: ['stage3-build-stabilization'],
    blocks: ['stage7-pre-prod'],
  },

  // ============================================================
  // STAGE 7 — Pre-PROD Deployment
  // ============================================================
  {
    id: 'stage7-pre-prod',
    displayOrder: 7,
    name: 'Pre-PROD Deployment',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      manualSubStep('deploy-configs-wem',      'Deploy configs to PROD WEM server'),
      manualSubStep('validate-3-4-passes',     'Validate 3-4 passes'),
      manualSubStep('execute-tech-validation', 'Execute technical validation per CDB Release runbook'),
    ],
    automatedChecks: [],   // manual stage — no API checks
    notes: [],
    override: null,
    dependsOn: ['stage5-war-promotion', 'stage6-doc-prep'],
  },

  // ============================================================
  // STAGE 8 — PROD Deployment
  // ============================================================
  {
    id: 'stage8-prod',
    displayOrder: 8,
    name: 'PROD Deployment',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      manualSubStep('repeat-config-war-verification', 'Repeat config/WAR verification'),
      manualSubStep('execute-tech-validation-prod',   'Execute technical validation'),
      manualSubStep('coordinate-traffic-switch',      'Coordinate traffic switch per PROD delivery letter'),
    ],
    automatedChecks: [],   // manual stage — no API checks
    notes: [],
    override: null,
    dependsOn: ['stage7-pre-prod'],
  },

  // ============================================================
  // STAGE 9 — Post-Go-Live
  // ============================================================
  {
    id: 'stage9-post-go-live',
    displayOrder: 9,
    name: 'Post-Go-Live',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      autoSubStep('update-f26-deployments-page',     'Update build versions on F26 Deployments page', ['check-f26-deployments-page']),
      autoSubStep('retrofit-cdb-ui-branch',          'Retrofit CDB UI release branch → master',       ['check-retrofit-cdb-ui-pr']),
      autoSubStep('retrofit-cdb-configs-branch',     'Retrofit CDB Configs release branch → master',  ['check-retrofit-cdb-configs-pr']),
      autoSubStep('retrofit-freddy-branch',          'Retrofit Freddy release branch → master',       ['check-retrofit-freddy-pr']),
      autoSubStep('tag-repos',                       'Tag repos (CDB, CDB_configs, Freddy)',          ['check-repo-tags']),
    ],
    automatedChecks: [
      check('check-f26-deployments-page',     'Confluence API: F26 Deployments page updated',                       'confluence'),
      check('check-retrofit-cdb-ui-pr',       'GitHub API: CDB UI retrofit PR merged to master',                    'github'),
      check('check-retrofit-cdb-configs-pr',  'GitHub API: CDB Configs retrofit PR merged to master',               'github'),
      check('check-retrofit-freddy-pr',       'GitHub API: Freddy retrofit PR merged to master',                    'github'),
      check('check-repo-tags',                'GitHub API: tags present on CDB, CDB_configs, Freddy',               'github'),
    ],
    notes: [],
    override: null,
    dependsOn: ['stage8-prod'],
  },

  // ============================================================
  // STAGE 10 — Post Mobile App Release
  // ============================================================
  {
    id: 'stage10-post-mobile',
    displayOrder: 10,
    name: 'Post Mobile App Release',
    kind: 'sequential',
    status: 'locked',
    startedAt: null,
    closedAt: null,
    subSteps: [
      manualSubStep('upload-prod-dsym-firebase', 'Upload PROD dSYM files to Firebase Console'),
    ],
    automatedChecks: [],   // Firebase API integration deferred
    notes: [],
    override: null,
    dependsOn: ['stage9-post-go-live'],
  },
];

/**
 * Returns a deep clone of STAGE_TEMPLATE so each new release gets a fresh,
 * independent copy. JSON round-trip is safe here because every field in the
 * template is a JSON-serialisable primitive, array, or plain object.
 */
export function cloneStageTemplate(): Stage[] {
  return JSON.parse(JSON.stringify(STAGE_TEMPLATE));
}
