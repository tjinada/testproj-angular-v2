import type {
  DecisionStep,
  Outcome,
  OutcomeKey,
  Resolution,
  Severity,
  SimState,
  SiteId
} from '../models/traffic-flow.model';
import {
  APIC_INSTANCES,
  APP_SERVERS,
  EDGE_COOKIE_BEATS_LIVENESS,
  SESSION_REPLICATED,
  SITES,
  VHOST_DEPLOYED,
  WEB_SERVERS
} from '../components/traffic-flow/traffic-topology';

/** Title and severity per outcome key. */
const OUTCOMES: Record<OutcomeKey, { title: string; severity: Severity }> = {
  DOWN503: { title: 'Service Unavailable — 503', severity: 'bad' },
  POOL_OFF: { title: 'Pool Offline — call rejected (DACT-104)', severity: 'bad' },
  VHOST: { title: 'Vhost Mismatch — 400/404', severity: 'bad' },
  LOCAL503: { title: 'Local 503 — no failover', severity: 'bad' },
  TIMEOUT: { title: 'Session Timeout — re-auth required', severity: 'bad' },
  SPLIT: { title: 'Split-site — degraded', severity: 'warn' },
  DRAINED: { title: 'Successful — still on the drained site', severity: 'warn' },
  NEW: { title: 'Successful — new session issued', severity: 'ok' },
  OK: { title: 'Successful', severity: 'ok' }
};

const other = (s: SiteId): SiteId => (s === 'BCC' ? 'SCC' : 'BCC');

/** Members of a tier that are still in service. */
function membersUp(state: SimState, tier: string, site: SiteId, count: number): number[] {
  const up: number[] = [];
  for (let i = 1; i <= count; i++) {
    if (!state.down[`${tier}-${site}-${i}`]) { up.push(i); }
  }
  return up;
}

const webUp = (s: SimState, site: SiteId) => membersUp(s, 'web', site, WEB_SERVERS);
const appUp = (s: SimState, site: SiteId) => membersUp(s, 'app', site, APP_SERVERS);
const apicUp = (s: SimState, site: SiteId) => membersUp(s, 'apic', site, APIC_INSTANCES);

/** Akamai's API GTM watches a TCP:443 check against the APIC farm. */
function apicHealthy(s: SimState, site: SiteId): boolean {
  return !s.down[`apicfs-${site}`] && apicUp(s, site).length > 0;
}

/** GTM health: /banking/live.txt served by IHS behind the LTM VIP. */
function bosHealthy(s: SimState, site: SiteId, api: boolean): boolean {
  if (s.live[site] !== 'present') { return false; }
  if (s.down[`ltm-${site}`] || webUp(s, site).length === 0) { return false; }
  if (api && s.down[`extgtm-${site}`]) { return false; }
  return true;
}

/** Physical reachability, independent of the liveness object. */
function reachable(s: SimState, site: SiteId): boolean {
  return !s.down[`ltm-${site}`] && webUp(s, site).length > 0;
}

/**
 * DACT-104. When the LTM pool monitor watches the liveness object rather than
 * the httpd TCP port, renaming that object marks every pool member offline —
 * the VIP has no members and rejects, even though httpd is still serving.
 */
function ltmPoolUp(s: SimState, site: SiteId): boolean {
  if (webUp(s, site).length === 0) { return false; }
  return s.ltmMonitor === 'tcp' || s.live[site] === 'present';
}

function outcome(key: OutcomeKey, why: string): Outcome {
  return { key, why, title: OUTCOMES[key].title, severity: OUTCOMES[key].severity };
}

/**
 * Resolves a SimState against the CDB topology. Pure: no I/O, no framework,
 * no dependency on rendering. Returns the served path, the outcome, and a
 * step-by-step decision trace whose ids link back to diagram nodes.
 */
export function resolveTraffic(state: SimState): Resolution {
  const api = state.path === 'api';
  const existing = state.session === 'existing';
  const pinned = state.site;
  const steps: DecisionStep[] = [];

  const step = (ids: string[], where: string, what: string, st: Severity = 'ok') =>
    steps.push({ ids, where, what, state: st });

  const done = (
    key: OutcomeKey, why: string, http: string,
    extra: Partial<Resolution> = {}
  ): Resolution => ({
    path: state.path, existing, pinnedSite: pinned,
    apicSite: null, bosSite: null, appServer: null,
    outcome: outcome(key, why), http, setCookie: null, steps, breakAt: null,
    ...extra
  });

  step(['client'], 'Client',
    `Request <b>www1.bmo.com${api ? '/api/cdb' : '/banking/services/*'}</b>. ` +
    (existing ? `Carries <b>cdbbossiteid=${pinned}</b>.` : 'No stickiness cookie yet.'));

  // ---- tier 1: Akamai picks the entry site --------------------------------
  let apicSite: SiteId | null = null;
  let edgeFailover = false;

  if (api) {
    if (apicHealthy(state, pinned)) { apicSite = pinned; }
    else if (apicHealthy(state, other(pinned))) { apicSite = other(pinned); edgeFailover = true; }

    step(['gtm-api'], 'Akamai GTM-CDB-API',
      apicSite === null
        ? 'TCP:443 check fails against the APIC farm on <b>both</b> sites.'
        : edgeFailover
          ? `TCP:443 check fails against APIC-${pinned} → the edge sends the request to <b>APIC-${apicSite}</b> instead.`
          : `Liveness is a <b>TCP check on 443</b>, site stickiness <b>apicsiteid</b>. Pinned to <b>${pinned}</b>.`,
      apicSite === null ? 'bad' : edgeFailover ? 'warn' : 'ok');

    if (apicSite === null) {
      return done('DOWN503',
        'The APIC farm is out of service on both sites, so the Akamai API GTM has no healthy datacentre.',
        '503', { breakAt: 'gtm-api' });
    }
  } else {
    step(['gtm-bos'], 'Akamai GTM-CDB-BOS',
      'Liveness <b>/banking/live.txt</b>, session stickiness cookie <b>cdbbossiteid</b>.');
  }

  step(['cloudlet'], 'Cloudlet Configuration',
    'Sets <b>x-bmo-env</b> (blue/Green) and <b>x-api-key</b> (pr1/pr2).');

  // ---- tier 2: pick the BOS site ------------------------------------------
  const from: SiteId = api ? (apicSite as SiteId) : pinned;
  let bosSite: SiteId | null = null;
  let bosFailover = false;
  let drained = false;

  if (!api && existing && EDGE_COOKIE_BEATS_LIVENESS && reachable(state, pinned)) {
    // The HTTP edge can read the cookie, so it wins over the liveness check.
    bosSite = pinned;
    drained = state.live[pinned] !== 'present';
  } else if (bosHealthy(state, from, api)) {
    bosSite = from;
  } else if (bosHealthy(state, other(from), api)) {
    bosSite = other(from);
    bosFailover = true;
  }

  if (api) {
    step([`apicfs-${apicSite}`], `APIC FS (${apicSite})`,
      `Routes into the ${apicSite} APIC farm — <b>${SITES[apicSite as SiteId].apicFs}</b>.`);
    step(apicUp(state, apicSite as SiteId).map(i => `apic-${apicSite}-${i}`),
      `APIC inst (${apicSite})`,
      `Gateway script uses its own FQDN to pick the BOS GTM hostname: <b>${SITES[apicSite as SiteId].extGtm}</b>.`);
    step([`extgtm-${apicSite}`], `EXT GTM DNS (${apicSite})`,
      bosSite === null
        ? 'No BOS site passes the <b>/banking/live.txt</b> check — no VIP to return.'
        : bosFailover
          ? `BOS-${apicSite} fails its healthcheck → returns the <b>${bosSite}</b> LTM VIP (the <b>0% failover</b> leg).`
          : 'Returns its own LTM VIP <b>100%</b> of the time.',
      bosSite === null ? 'bad' : bosFailover ? 'warn' : 'ok');
  }

  // On the banking path the GTM step itself carries the failover narrative.
  if (!api) {
    if (bosSite === null) {
      steps[1].what = 'No BOS site passes the <b>/banking/live.txt</b> check.';
      steps[1].state = 'bad';
    } else if (drained) {
      steps[1].what =
        `live.txt is renamed on ${pinned}, but this is an HTTP edge and it can read ` +
        `<b>cdbbossiteid=${pinned}</b>. The cookie wins over the liveness check, so the ` +
        `session stays on <b>${pinned}</b> — IHS is still serving.`;
      steps[1].state = 'warn';
    } else if (bosFailover) {
      steps[1].what =
        `BOS-${pinned} fails its healthcheck → the whole request is rerouted down the <b>${bosSite}</b> column.`;
      steps[1].state = 'warn';
    }
  }

  if (bosSite === null) {
    return done('DOWN503',
      'Neither site serves /banking/live.txt behind a healthy LTM and web tier.',
      '503', { apicSite, breakAt: api ? `extgtm-${apicSite}` : 'gtm-bos' });
  }

  // ---- vhost precondition (environment fact) ------------------------------
  if (api && bosFailover && !VHOST_DEPLOYED) {
    step([`ltm-${bosSite}`], `BOS LTM (${bosSite})`,
      `CWH-WEB VIP <b>${SITES[bosSite].ltmHost} ${SITES[bosSite].ltmVip}</b>.`);
    step(webUp(state, bosSite).map(i => `web-${bosSite}-${i}`), `BOS Web (${bosSite})`,
      `IHS receives <b>Host: ${SITES[apicSite as SiteId].extGtm}</b> and httpd.conf has no ` +
      'matching vhost. Rejected before session state matters.', 'bad');
    return done('VHOST',
      `APIC-${apicSite} still sends Host: ${SITES[apicSite as SiteId].extGtm}. The GTM failover is ` +
      `invisible to it, and ${bosSite} IHS has no vhost for that host.`,
      '400/404',
      { apicSite, bosSite, breakAt: `web-${bosSite}-${webUp(state, bosSite)[0] ?? 1}` });
  }

  // ---- LTM pool availability (DACT-104) -----------------------------------
  if (!ltmPoolUp(state, bosSite)) {
    step([`ltm-${bosSite}`], `BOS LTM (${bosSite})`,
      'The pool monitor is <b>/banking/live.txt</b>, not the httpd TCP port. The object is ' +
      `renamed on <b>${bosSite}</b>, so every pool member is marked <b>offline</b>. The VIP ` +
      'has no members left and rejects the connection.', 'bad');
    return done('POOL_OFF',
      'The BOS LTM monitors /banking/live.txt instead of the httpd TCP port, so renaming the ' +
      'object takes the whole pool offline and the call is rejected outright — even though ' +
      'httpd and the app are still running.',
      'RST', { apicSite, bosSite, breakAt: `ltm-${bosSite}` });
  }

  step([`ltm-${bosSite}`], `BOS LTM (${bosSite})`,
    `CWH-WEB VIP <b>${SITES[bosSite].ltmHost} ${SITES[bosSite].ltmVip}</b> → web tier.`);

  const webs = webUp(state, bosSite);
  const apps = appUp(state, bosSite);

  step(webs.map(i => `web-${bosSite}-${i}`), `BOS Web (${bosSite})`,
    webs.length === WEB_SERVERS
      ? 'Both IHS servers are in service; the plugin routes to the JVM holding the session by clone ID.'
      : `Only <b>Server ${webs[0]}</b> is in service — the LTM sends everything there.`);

  if (apps.length === 0) {
    const all: string[] = [];
    for (let i = 1; i <= APP_SERVERS; i++) { all.push(`app-${bosSite}-${i}`); }
    step(all, `BOS App (${bosSite})`,
      'Every cluster member is out of service. IHS has no available JVM and returns 503 locally.', 'bad');
    return done('LOCAL503',
      `live.txt is still present on ${bosSite}, so the GTM keeps sending traffic here — but no app ` +
      'server is in service. Liveness and app health are independent signals; nothing fails over.',
      '503', { apicSite, bosSite, breakAt: `app-${bosSite}-1` });
  }

  // ---- session outcome ----------------------------------------------------
  const crossSite = existing && bosSite !== pinned;
  const jvmGone = existing && !crossSite && apps.indexOf(state.jsession) < 0;
  const appServer = crossSite || jvmGone || !existing ? apps[0] : state.jsession;

  let key: OutcomeKey;
  let why: string;

  if (crossSite && !SESSION_REPLICATED) {
    key = 'TIMEOUT';
    why = `JSESSIONID was issued by ${pinned} App Server ${state.jsession}. That clone ID is not ` +
      `in ${bosSite}'s plugin-cfg.xml and session replication is off.`;
  } else if (jvmGone) {
    key = 'TIMEOUT';
    why = `App Server ${state.jsession} on ${bosSite} is out of service. The plugin falls back to ` +
      'another local JVM, which does not hold this session — no site failover involved.';
  } else if (api && apicSite !== bosSite) {
    key = 'SPLIT';
    why = `APIC runs on ${apicSite} but BOS runs on ${bosSite}` +
      (existing ? `, while the cookie still reads ${pinned}` : '') +
      '. Served, but half failed over.';
  } else if (drained) {
    key = 'DRAINED';
    why = `live.txt is renamed on ${pinned}, but the cookie pins this session there and IHS is ` +
      'still serving. The request succeeds on the site you are trying to empty — this is why a ' +
      'drain bleeds instead of cutting.';
  } else if (!existing) {
    key = 'NEW';
    why = `No stickiness cookie. The edge assigns ${bosSite} and the app issues fresh cookies.`;
  } else {
    key = 'OK';
    why = `Cookie pins ${bosSite}, the site is healthy, and the plugin routes to App Server ${appServer}.`;
  }

  step([`app-${bosSite}-${appServer}`], `BOS App (${bosSite})`,
    key === 'TIMEOUT'
      ? `A fresh empty session is created on <b>App Server ${appServer}</b> — user is bounced to login.`
      : existing
        ? `App Server <b>${appServer}</b> holds the session state.`
        : `App issues <b>JSESSIONID</b> with jvmRoute for <b>App Server ${appServer}</b>.`,
    key === 'TIMEOUT' ? 'bad' : 'ok');

  const suffix = `${bosSite.toLowerCase()}app${appServer}`;
  const setCookie = !existing
    ? `cdbbossiteid=${bosSite}; JSESSIONID=…${suffix}`
    : key === 'TIMEOUT'
      ? `JSESSIONID=…${suffix} (new)`
      : null;

  return done(key, why, key === 'TIMEOUT' ? '302 → login' : '200 OK', {
    apicSite,
    bosSite,
    appServer,
    setCookie,
    breakAt: key === 'TIMEOUT' ? `app-${bosSite}-${appServer}` : null
  });
}
