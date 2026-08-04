import type { Scenario, StageScenario } from '../../models/traffic-flow.model';
import { APP_SERVERS } from './traffic-topology';

/**
 * Journey scenarios: one user followed through time, carrying their cookie and
 * JSESSIONID forward so later steps see the consequences of earlier ones.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: 'drain-restore',
    title: 'Drain BCC, then restore it',
    blurb: 'Why restoring live.txt causes a second wave of timeouts.',
    steps: [
      { kind: 'request', label: 'User arrives for the first time', path: 'api' },
      { kind: 'request', label: 'User continues their session', path: 'api' },
      { kind: 'env', label: 'Rename live.txt on BCC',
        apply: e => { e.live.BCC = 'renamed'; } },
      { kind: 'request', label: 'User continues — new behaviour', path: 'api' },
      { kind: 'env', label: 'Restore live.txt on BCC',
        apply: e => { e.live.BCC = 'present'; } },
      { kind: 'request', label: 'User continues — new behaviour', path: 'api' }
    ]
  },
  {
    id: 'jvm-dr',
    title: 'JVM lost during an active session',
    blurb: 'A local JVM failure, then a drain on top of it.',
    steps: [
      { kind: 'request', label: 'User establishes a session on BCC', path: 'api' },
      { kind: 'request', label: 'User continues their session', path: 'api' },
      { kind: 'env', label: 'App Server 1 (BCC) goes offline',
        apply: e => { e.down['app-BCC-1'] = true; } },
      { kind: 'request', label: 'User continues — pinned JVM is gone', path: 'api' },
      { kind: 'env', label: 'Rename live.txt on BCC to move traffic away',
        apply: e => { e.live.BCC = 'renamed'; } },
      { kind: 'request', label: 'User continues after the drain', path: 'api' }
    ]
  },
  {
    id: 'banking-drain',
    title: 'Drain BCC on /banking/services',
    blurb: 'DACT-104 turns a bleed into a hard rejection.',
    steps: [
      { kind: 'request', label: 'User arrives for the first time', path: 'banking' },
      { kind: 'env', label: 'Rename live.txt on BCC',
        apply: e => { e.live.BCC = 'renamed'; } },
      { kind: 'request', label: 'Existing user — does the drain hold?', path: 'banking' },
      { kind: 'env', label: 'Switch BOS LTM monitor to httpd TCP',
        apply: e => { e.ltmMonitor = 'tcp'; } },
      { kind: 'request', label: 'Existing user, with DACT-104 fixed', path: 'banking' }
    ]
  }
];


/**
 * Stage scenarios: the estate walked through stages, with every cohort
 * observed at each one. Use these when the question is "who is broken right
 * now" rather than "what happens to this person next".
 */
export const DR_SCENARIOS: StageScenario[] = [
  {
    id: 'dr-bos-app-down',
    title: 'DR — CDB BOS app down at BCC',
    blurb: 'All six JVMs lost, then a manual drain. Four cohorts, five stages.',
    cohorts: [
      { id: 'bank-new', label: 'New · /banking/services', path: 'banking', kind: 'new' },
      { id: 'bank-existing', label: 'Existing · /banking/services',
        path: 'banking', kind: 'existing', seedSite: 'BCC' },
      { id: 'api-new', label: 'New · /api/cdb', path: 'api', kind: 'new' },
      { id: 'api-existing', label: 'Existing · /api/cdb',
        path: 'api', kind: 'existing', seedSite: 'BCC' }
    ],
    stages: [
      {
        label: 'Healthy baseline',
        note: 'Both sites in service. Everyone lands on BCC.',
        apply: () => { /* no change */ }
      },
      {
        label: 'All 6 BCC JVMs down',
        note: 'live.txt is still served and the LTM pool is up, so every GTM ' +
          'still sees BCC as healthy. Traffic keeps arriving; nothing fails over.',
        apply: e => {
          for (let i = 1; i <= APP_SERVERS; i++) { e.down[`app-BCC-${i}`] = true; }
        }
      },
      {
        label: 'live.txt renamed on BCC',
        note: 'Renamed on both BCC web servers. This is the first thing that ' +
          'actually moves traffic — and it splits the cohorts four ways.',
        apply: e => { e.live.BCC = 'renamed'; }
      },
      {
        label: 'BOS LTM monitor → httpd TCP',
        note: 'DACT-104 remediation. The pool stops going offline when the ' +
          'liveness object is renamed.',
        apply: e => { e.ltmMonitor = 'tcp'; }
      },
      {
        label: 'live.txt restored on BCC',
        note: 'JVMs are still down. Watch which cohorts are sent back to a ' +
          'site that cannot serve them.',
        apply: e => { e.live.BCC = 'present'; }
      }
    ]
  }
];
