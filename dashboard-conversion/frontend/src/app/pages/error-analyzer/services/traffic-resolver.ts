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
  COOKIE_BYPASSES_GTM,
  ISAM_SHARES_SITE_COOKIE,
  SESSION_REPLICATED,
  SITES,
  SITE_COOKIE_NAME,
  VHOST_DEPLOYED,
  WEB_SERVERS,
  WGA_INSTANCES
} from '../components/traffic-flow/traffic-topology';

/** Title and severity per outcome key. */
const OUTCOMES: Record<OutcomeKey, { title: string; severity: Severity }> = {
  DOWN503: { title: 'Service Unavailable — 503', severity: 'bad' },
  ISAM500: { title: 'initISAMSession failed — 500', severity: 'bad' },
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
const wgaUp = (s: SimState, site: SiteId) => membersUp(s, 'wga', site, WGA_INSTANCES);

/** Akamai's API GTM watches a TCP:443 check against the APIC farm. */
function apicHealthy(s: SimState, site: SiteId): boolean {
  return !s.down[`apicfs-${site}`] && apicUp(s, site).length > 0;
}

/**
 * Site health as a GTM sees it. Both GTMs probe the BOS LTM VIP, so the site is
 * unreachable if the LTM or the whole web tier is out. What the probe *is*
 * differs by tier: the EXT GTM's monitor is configurable, while the Akamai BOS
 * GTM watches /banking/live.txt per the Requirements box on the architecture
 * diagram. A TCP monitor keeps passing when the object is renamed, so the
 * liveness drain has no effect on that tier.
 */
function bosHealthy(s: SimState, site: SiteId, api: boolean): boolean {
  if (s.down[`ltm-${site}`] || webUp(s, site).length === 0) { return false; }
  const monitor = api ? s.extGtmMonitor : 'live';
  if (monitor === 'live' && s.live[site] !== 'present') { return false; }
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

function outcome(key: OutcomeKey, why: string, sev?: Severity | null): Outcome {
  return { key, why, title: OUTCOMES[key].title, severity: sev ?? OUTCOMES[key].severity };
}

/**
 * Resolves a SimState against the CDB topology. Pure: no I/O, no framework,
 * no dependency on rendering. Returns the served path, the outcome, and a
 * step-by-step decision trace whose ids link back to diagram nodes.
 */
export function resolveTraffic(state: SimState): Resolution {
  const api = state.path === 'api';
  const csgcb = state.path === 'csgcb';
  // csgcb is post-auth, so the cookie is always present. Deriving `existing`
  // rather than trusting state guards against a hand-edited share link
  // arriving as path=csgcb&sess=new.
  const existing = csgcb || state.session === 'existing';
  const pinned = state.site;
  const steps: DecisionStep[] = [];

  const step = (ids: string[], where: string, what: string, st: Severity = 'ok') =>
    steps.push({ ids, where, what, state: st });

  /** cdbbossiteId value the edge stamps; set once the target origin is known. */
  let stampedCookie: string | null = null;

  /** Set when an outcome is worse than its table default. See the SPLIT branch. */
  let sevOverride: Severity | null = null;

  // Distribution shown inside each GTM oval. A GTM only splits traffic when
  // both its datacentres pass their check; otherwise it answers 100% one way.
  const apiHealth = { BCC: apicHealthy(state, 'BCC'), SCC: apicHealthy(state, 'SCC') };
  const bosHealth = { BCC: bosHealthy(state, 'BCC', false), SCC: bosHealthy(state, 'SCC', false) };
  const distribution = (h: Record<SiteId, boolean>): string => {
    if (h.BCC && h.SCC) { return '50/50'; }
    if (h.BCC) { return '100% → BCC'; }
    if (h.SCC) { return '100% → SCC'; }
    return 'no healthy DC';
  };
  const gtmDistribution = { api: distribution(apiHealth), bos: distribution(bosHealth) };

  // Which site each GTM actually answers with. The operator's pick only stands
  // while both datacentres pass; otherwise health decides for it.
  const answer = (h: Record<SiteId, boolean>, pick: SiteId): SiteId | null => {
    if (h.BCC && h.SCC) { return pick; }
    if (h.BCC) { return 'BCC'; }
    if (h.SCC) { return 'SCC'; }
    return null;
  };
  const gtmAnswer = {
    api: answer(apiHealth, state.gtmPick.api),
    bos: answer(bosHealth, state.gtmPick.bos)
  };

  // EXT GTM legs: each answers with its own VIP unless its site fails the check.
  const extHealth = { BCC: bosHealthy(state, 'BCC', true), SCC: bosHealthy(state, 'SCC', true) };
  const extGtmSplit = {
    BCC: extHealth.BCC ? { own: '100%', cross: '0% (failover)' }
                       : { own: '0%', cross: extHealth.SCC ? '100% (failover)' : '0% (failover)' },
    SCC: extHealth.SCC ? { own: '100%', cross: '0% (failover)' }
                       : { own: '0%', cross: extHealth.BCC ? '100% (failover)' : '0% (failover)' }
  };

  const done = (
    key: OutcomeKey, why: string, http: string,
    extra: Partial<Resolution> = {}
  ): Resolution => ({
    path: state.path, existing, pinnedSite: pinned,
    apicSite: null, bosSite: null, appServer: null,
    gtmDistribution, gtmAnswer, gtmActive: !existing, extGtmSplit,
    outcome: outcome(key, why, sevOverride), http, setCookie: null,
    cookieStamped: stampedCookie, steps, breakAt: null,
    ...extra
  });

  /** The edge stamps <env>-<SITE> based on the origin it targeted. */
  const stamp = (site: SiteId) => {
    stampedCookie = `${SITE_COOKIE_NAME}=<env>-${site}`;
  };

  const urlPath = api ? '/api/cdb' : csgcb ? '/banking/services/csgcb' : '/banking/services/*';

  step(['client'], 'Client',
    `Request <b>www1.bmo.com${urlPath}</b>. ` +
    (csgcb
      ? `Post-auth, so it always carries a <b>${SITE_COOKIE_NAME}</b> — here pinning <b>${pinned}</b>.`
      : existing
        ? `Carries a valid <b>${SITE_COOKIE_NAME}</b> pinning <b>${pinned}</b>.`
        : `No <b>${SITE_COOKIE_NAME}</b> yet.`));

  // ---- tier 1: the Akamai edge picks the origin ---------------------------
  // A valid site cookie assigns PMUSER_TARGET a hardcoded hostname, so
  // populate-cname-chain never runs and the GTM is never queried. Health only
  // reaches traffic through the CNAME chain, i.e. only cookie-less requests.
  const cookieBypass = existing && COOKIE_BYPASSES_GTM;
  let apicSite: SiteId | null = null;
  let edgeFailover = false;

  if (api) {
    if (cookieBypass) {
      apicSite = pinned;
      stamp(pinned);
      step(['gtm-api'], 'Akamai edge',
        `Valid <b>${SITE_COOKIE_NAME}</b> → PMUSER_TARGET is hardcoded to ` +
        `<b>${SITES[pinned].apicFs}</b>. populate-cname-chain never runs, so the GTM ` +
        'and its TCP:443 check are never consulted.');
      if (!apicHealthy(state, pinned)) {
        return done('DOWN503',
          `The ${pinned} APIC farm is out of service, but the cookie pinned the origin directly and ` +
          'the GTM was never queried — there is no failover path. The edge forwards to a dead origin.',
          '503', { apicSite, breakAt: `apicfs-${pinned}` });
      }
    } else {
      const pick = state.gtmPick.api;
      if (apicHealthy(state, pick)) { apicSite = pick; }
      else if (apicHealthy(state, other(pick))) { apicSite = other(pick); edgeFailover = true; }
      if (apicSite) { stamp(apicSite); }

      step(['gtm-api'], 'Akamai GTM-CDB-API',
        apicSite === null
          ? 'No cookie → the CNAME chain resolves, but the TCP:443 check fails against the APIC farm on <b>both</b> sites.'
          : edgeFailover
            ? `No cookie → the CNAME chain resolves. TCP:443 fails against APIC-${pick}, so the GTM answers <b>100% ${apicSite}</b> and the 50/50 split is overridden.`
            : `No cookie → the CNAME chain resolves. The 50/50 lands on <b>${apicSite}</b>; the edge stamps <b>${SITE_COOKIE_NAME}</b> from the answer.`,
        apicSite === null ? 'bad' : edgeFailover ? 'warn' : 'ok');

      if (apicSite === null) {
        return done('DOWN503',
          'The APIC farm is out of service on both sites, so the API GTM has no healthy datacentre.',
          '503', { breakAt: 'gtm-api' });
      }
    }
  } else if (csgcb) {
    // The property rule matches the path and the cookie, assigns PMUSER_TARGET
    // the ISAM front door, and stops. No GTM, no liveness, no cloudlet.
    stamp(pinned);
    step(['akamai-prop'], 'Akamai property rule',
      `Path matches <b>/banking/services/csgcb</b> and the request carries ` +
      `<b>${SITE_COOKIE_NAME}</b> pinning <b>${pinned}</b> → PMUSER_TARGET is hardcoded to ` +
      `<b>${SITES[pinned].isamLtm}</b>. No GTM query, no liveness check, and no cloudlet — ` +
      'legacy ISAM has no blue/green instances, so there is no env header to set.');

    if (state.down[`isamltm-${pinned}`]) {
      return done('DOWN503',
        `The ${pinned} ISAM LTM is out of service. The cookie pinned it directly and legacy ISAM ` +
        'has no failover leg, so there is nowhere else for the edge to go.',
        '503', { breakAt: `isamltm-${pinned}` });
    }

    const wgas = wgaUp(state, pinned);
    if (wgas.length === 0) {
      return done('DOWN503',
        `Every WGA instance on ${pinned} is out of service, so the ISAM LTM pool is empty and the ` +
        'VIP rejects. There is no cross-site leg to fall back to.',
        '503', { breakAt: `isamltm-${pinned}` });
    }

    step([`isamltm-${pinned}`], `ISAM LTM (${pinned})`,
      `VIP <b>${SITES[pinned].isamLtm}</b> → WGA tier. The pool monitor is a plain TCP check, so ` +
      'the liveness object is never consulted at this tier.');

    const wgaIds = wgas.map(i => `wga-${pinned}-${i}`);

    // The WGA junction is hard-wired same-site. This is where the shared-cookie
    // defect actually lands: ISAM inherited an answer about APIC and applied it
    // to BOS.
    if (!reachable(state, pinned)) {
      step(wgaIds, `ISAM WGA (${pinned})`,
        `The junction is hard-wired to same-site BOS — <b>${SITES[pinned].ltmHost}</b>. ` +
        `${pinned} BOS is down and legacy ISAM has no failover leg of its own, so ` +
        '<b>initISAMSession</b> fails.', 'bad');
      return done('ISAM500',
        `${SITE_COOKIE_NAME} pinned ${pinned} ISAM, whose junction reaches only ${pinned} BOS — ` +
        'and that site is down. Legacy ISAM shares the cookie with APIC but not APIC\'s failover, ' +
        `so it cannot reach ${other(pinned)} BOS the way the /api/cdb path can.`,
        '500', { breakAt: `wga-${pinned}-${wgas[0]}` });
    }

    step(wgaIds, `ISAM WGA (${pinned})`,
      `Junction forwards to same-site BOS — <b>${SITES[pinned].ltmHost}</b>. No cross-site leg.`);
  } else if (cookieBypass) {
    stamp(pinned);
    step(['gtm-bos'], 'Akamai edge',
      `Valid <b>${SITE_COOKIE_NAME}</b> → PMUSER_TARGET is hardcoded to ` +
      `<b>${SITES[pinned].ltmHost}</b>. populate-cname-chain never runs, so ` +
      '<b>/banking/live.txt</b> is never consulted on this request.');
  } else {
    step(['gtm-bos'], 'Akamai GTM-CDB-BOS',
      'No cookie → the CNAME chain resolves and liveness <b>/banking/live.txt</b> decides the site.');
  }

  // csgcb never passes through the cloudlet — ISAM has no blue/green instances.
  if (!csgcb) {
    step(['cloudlet'], 'Cloudlet Configuration',
      'Sets <b>x-bmo-env</b> (blue/Green) and <b>x-api-key</b> (pr1/pr2).');
  }

  // ---- tier 2: pick the BOS site ------------------------------------------
  const from: SiteId = api ? (apicSite as SiteId) : (cookieBypass ? pinned : state.gtmPick.bos);
  let bosSite: SiteId | null = null;
  let bosFailover = false;
  let drained = false;

  if (!api && cookieBypass) {
    // PMUSER_TARGET is the pinned LTM VIP. No GTM answer, so no failover leg.
    if (!reachable(state, pinned)) {
      return done('DOWN503',
        `The ${pinned} BOS tier is unreachable, but the cookie pinned the LTM VIP directly and the ` +
        'GTM was never queried — there is no failover path.',
        '503', { breakAt: `ltm-${pinned}` });
    }
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
    const mon = state.extGtmMonitor === 'live' ? '/banking/live.txt' : 'httpd TCP';
    step([`extgtm-${apicSite}`], `EXT GTM DNS (${apicSite})`,
      bosSite === null
        ? `No BOS site passes the <b>${mon}</b> monitor — no VIP to return.`
        : bosFailover
          ? `BOS-${apicSite} fails its <b>${mon}</b> monitor → returns the <b>${bosSite}</b> LTM VIP (the <b>0% failover</b> leg).`
          : state.extGtmMonitor === 'tcp' && state.live[apicSite as SiteId] !== 'present'
            ? `Monitor is <b>httpd TCP</b>, not the liveness object, so the renamed live.txt is invisible here — returns the <b>${bosSite}</b> VIP <b>100%</b>.`
            : `Monitor <b>${mon}</b> passes — returns the <b>${bosSite}</b> LTM VIP <b>100%</b> of the time.`,
      bosSite === null ? 'bad' : bosFailover ? 'warn' : 'ok');
  }

  // A cookie-less banking request is stamped from whatever the GTM answered.
  if (!api && !cookieBypass && bosSite) { stamp(bosSite); }

  // On the banking path the GTM step itself carries the failover narrative.
  // csgcb is excluded: it has no GTM step, and its step indices differ because
  // there is no cloudlet hop.
  if (!api && !csgcb) {
    if (bosSite === null) {
      steps[1].what = 'No BOS site passes the <b>/banking/live.txt</b> check.';
      steps[1].state = 'bad';
    } else if (drained) {
      steps[1].what +=
        ` live.txt is renamed on ${pinned}, but nothing on this request path reads it — ` +
        'the request goes straight to the pinned VIP and IHS is still serving.';
      steps[1].state = 'warn';
    } else if (bosFailover) {
      steps[1].what =
        `No cookie → the CNAME chain resolves. BOS-${from} fails <b>/banking/live.txt</b>, so the GTM ` +
        `answers <b>100% ${bosSite}</b> and the 50/50 split is overridden.`;
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

    // The cookie records which APIC answered, and legacy ISAM reads it as if it
    // were a statement about BOS. This request succeeds; the next csgcb call is
    // the one that pays. Whether it 500s turns on physical reachability, not on
    // the monitor: a liveness drain splits the path but leaves IHS serving, so
    // ISAM still works. A real outage does not.
    if (ISAM_SHARES_SITE_COOKIE) {
      const isamTarget = apicSite as SiteId;
      const isamDead = !reachable(state, isamTarget);
      why += ` The edge stamps ${SITE_COOKIE_NAME}=<env>-${isamTarget} from the APIC answer, and ` +
        `legacy ISAM shares that cookie — so the next /banking/services/csgcb call pins ` +
        `${isamTarget} ISAM, which is hard-wired to ${isamTarget} BOS` +
        (isamDead
          ? `. That site is down, so initISAMSession will return 500.`
          : `. That site is still reachable, so initISAMSession holds — but it breaks the moment ` +
            `${isamTarget} BOS goes down.`);
      if (isamDead) { sevOverride = 'bad'; }
    }
  } else if (drained) {
    key = 'DRAINED';
    why = `The cookie pinned the origin directly, so the GTM was never queried and live.txt was ` +
      `never read. IHS on ${pinned} is still serving, so the request succeeds on the site you are ` +
      'trying to empty. Health is not overridden here — it is simply not consulted, which is why a ' +
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
  // The site cookie is reported separately as cookieStamped; this is the
  // application's own session cookie.
  const setCookie = !existing
    ? `JSESSIONID=…${suffix}`
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