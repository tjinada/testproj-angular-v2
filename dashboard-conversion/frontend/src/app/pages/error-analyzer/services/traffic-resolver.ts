import type {
  DecisionStep,
  DownstreamKind,
  DownstreamRoute,
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
  CDBBOS_DOWNSTREAM,
  COOKIE_BYPASSES_GTM,
  IDP_COOKIE_NAME,
  IDP_LIVENESS,
  IDP_WGA_INSTANCES,
  ISAM_GTM_HOSTNAME,
  LAMBDAS,
  ISAM_SHARES_SITE_COOKIE,
  SESSION_REPLICATED,
  SITES,
  SITE_COOKIE_NAME,
  SSS_GSS_HOSTNAME,
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
  DS500: { title: 'Downstream unreachable — 500', severity: 'bad' },
  PARTIAL: { title: 'Partial — some endpoints return 500', severity: 'bad' },
  SPLIT: { title: 'Split-site — degraded', severity: 'warn' },
  DRAINED: { title: 'Successful — still on the drained site', severity: 'warn' },
  DS_FAILOVER: { title: 'Successful — downstream failed over', severity: 'warn' },
  NEW: { title: 'Successful — new session issued', severity: 'ok' },
  OK: { title: 'Successful', severity: 'ok' }
};

const other = (s: SiteId): SiteId => (s === 'BCC' ? 'SCC' : 'BCC');

/** Members of a tier that are still in service. Shared tiers pass a null site. */
function membersUp(state: SimState, tier: string, site: SiteId | null, count: number): number[] {
  const up: number[] = [];
  for (let i = 1; i <= count; i++) {
    if (!state.down[site ? `${tier}-${site}-${i}` : `${tier}-${i}`]) { up.push(i); }
  }
  return up;
}

const webUp = (s: SimState, site: SiteId) => membersUp(s, 'web', site, WEB_SERVERS);
const appUp = (s: SimState, site: SiteId) => membersUp(s, 'app', site, APP_SERVERS);
const apicUp = (s: SimState, site: SiteId) => membersUp(s, 'apic', site, APIC_INSTANCES);
const wgaUp = (s: SimState, site: SiteId) => membersUp(s, 'wga', site, WGA_INSTANCES);
const idpWgaUp = (s: SimState, site: SiteId) => membersUp(s, 'idpwga', site, IDP_WGA_INSTANCES);

/** The IdP front door can physically serve: LTM in service with a WGA behind it. */
function idpReachable(s: SimState, site: SiteId): boolean {
  return !s.down[`idpltm-${site}`] && idpWgaUp(s, site).length > 0;
}

/** Site health as GTM-ISAM sees it: reachable, and the liveness object present. */
function idpHealthy(s: SimState, site: SiteId): boolean {
  return idpReachable(s, site) && s.idpLive[site] === 'present';
}

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

/**
 * SSS V2 site health as the GSSes see it: the F5 up with a healthy APIC behind
 * it. An F5 whose APIC pool is empty is as good as down, so both GSS kinds
 * fail over. Direct site hosts never consult this — they hit the site anyway.
 */
const sssSiteUp = (s: SimState, site: SiteId) => !s.down[`sssf5-${site}`] && !s.down[`sssapic-${site}`];

/**
 * Resolves one downstream SSS V2 call from `site` through to AWS. Pure.
 *
 * The host decides the site (GSS 50/50, per-site GSS, or the site host with no
 * failover); the path decides the route through APIC. /api/cdb goes to Channel
 * Services, which calls back into the same site's APIC /api; /api goes straight
 * to the AWS API Gateway.
 */
function downstreamRoute(
  state: SimState, source: string, site: SiteId,
  kind: DownstreamKind, host: string, path: '/api/cdb' | '/api'
): DownstreamRoute {
  const legs: [string, string][] = [];
  const broken = (at: string): DownstreamRoute =>
    ({ host, kind, path, site: target, status: 'broken', legs, breakAt: at });
  const up = { BCC: sssSiteUp(state, 'BCC'), SCC: sssSiteUp(state, 'SCC') };

  let target: SiteId | null = null;
  let failover = false;
  if (kind === 'gss') {
    legs.push([source, 'gss-es']);
    const pick = state.gtmPick.sss;
    target = up[pick] ? pick : up[other(pick)] ? other(pick) : null;
    if (!target) { return broken('gss-es'); }
    failover = target !== pick;
    legs.push(['gss-es', `sssf5-${target}`]);
  } else if (kind === 'sitegss') {
    legs.push([source, `gss-${site}`]);
    target = up[site] ? site : up[other(site)] ? other(site) : null;
    if (!target) { return broken(`gss-${site}`); }
    failover = target !== site;
    legs.push([`gss-${site}`, `sssf5-${target}`]);
  } else {
    target = site;
    legs.push([source, `sssf5-${site}`]);
    if (state.down[`sssf5-${site}`]) { return broken(`sssf5-${site}`); }
  }

  const sec = path === '/api/cdb' ? 'cdb' : 'api';
  legs.push([`sssf5-${target}`, `sssapic-${target}#${sec}`]);
  if (state.down[`sssapic-${target}`]) { return broken(`sssapic-${target}`); }

  if (path === '/api/cdb') {
    legs.push([`sssapic-${target}#cdb`, `ocp-${target}`]);
    if (state.down[`ocp-${target}`]) { return broken(`ocp-${target}`); }
    legs.push([`ocp-${target}`, `sssapic-${target}#api`]);
  }

  legs.push([`sssapic-${target}#api`, 'awsgw']);
  if (state.down['awsgw']) { return broken('awsgw'); }
  const lambdas = membersUp(state, 'lambda', null, LAMBDAS);
  if (lambdas.length === 0) {
    for (let i = 1; i <= LAMBDAS; i++) { legs.push(['awsgw', `lambda-${i}`]); }
    return broken('lambda-1');
  }
  lambdas.forEach(i => legs.push(['awsgw', `lambda-${i}`]));

  return { host, kind, path, site: target, status: failover ? 'failover' : 'ok', legs, breakAt: null };
}

/** Every downstream call CDBBOS makes from a site. */
function cdbbosDownstream(state: SimState, site: SiteId): DownstreamRoute[] {
  return CDBBOS_DOWNSTREAM.map(d => ({
    ...downstreamRoute(state, `cdbbos-${site}`, site, d.kind, d.host(site), d.path),
    example: d.example
  }));
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
  const idpHealth = { BCC: idpHealthy(state, 'BCC'), SCC: idpHealthy(state, 'SCC') };
  // GTM-Auth-SPA-API is the same akadns property as GTM-CDB-API, so it shares
  // the APIC TCP:443 health; only its 50/50 pick is its own.
  const sssHealth = { BCC: sssSiteUp(state, 'BCC'), SCC: sssSiteUp(state, 'SCC') };
  const gtmDistribution = {
    api: distribution(apiHealth), bos: distribution(bosHealth),
    isam: distribution(idpHealth), spa: distribution(apiHealth), sss: distribution(sssHealth)
  };

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
    bos: answer(bosHealth, state.gtmPick.bos),
    isam: answer(idpHealth, state.gtmPick.isam),
    spa: answer(apiHealth, state.gtmPick.spa),
    sss: answer(sssHealth, state.gtmPick.sss)
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
    cookieStamped: stampedCookie, stampedSite, steps, breakAt: null, downstream: [],
    ...extra
  });

  /** The edge stamps <env>-<SITE> based on the origin it targeted. */
  let stampedSite: SiteId | null = null;
  const stamp = (site: SiteId) => {
    stampedSite = site;
    stampedCookie = `${SITE_COOKIE_NAME}=<env>-${site}`;
  };

  // ---- authentication.bmo.com: its own GTM, its own cookie ----------------
  if (state.path === 'idp') {
    const idpPinned: SiteId | null = existing ? state.idpSite ?? null : null;
    const stampIdp = (site: SiteId) => {
      stampedSite = site;
      stampedCookie = `${IDP_COOKIE_NAME}=${site}`;
    };

    step(['client'], 'Client',
      'Request <b>authentication.bmo.com/aac/*</b>. ' +
      (idpPinned
        ? `Carries <b>${IDP_COOKIE_NAME}</b> pinning <b>${idpPinned}</b>.`
        : `No <b>${IDP_COOKIE_NAME}</b> yet.`));

    let site: SiteId;
    if (idpPinned) {
      site = idpPinned;
      const renamed = state.idpLive[site] !== 'present';
      step(['gtm-isam'], 'Akamai edge',
        `Valid <b>${IDP_COOKIE_NAME}</b> → pinned to <b>${SITES[site].idpLtm}</b>. ` +
        `GTM-ISAM and its <b>${IDP_LIVENESS}</b> check are never consulted.` +
        (renamed
          ? ` The liveness object is renamed on ${site}, but nothing on this path reads it.`
          : ''),
        renamed ? 'warn' : 'ok');
    } else {
      const pick = state.gtmPick.isam;
      const answered = gtmAnswer.isam;
      const overridden = answered !== null && answered !== pick;
      step(['gtm-isam'], 'Akamai GTM-ISAM',
        answered === null
          ? `No ${IDP_COOKIE_NAME} → <b>${ISAM_GTM_HOSTNAME}</b> resolves, but no site passes <b>${IDP_LIVENESS}</b>.`
          : overridden
            ? `No ${IDP_COOKIE_NAME} → ISAM-${pick} fails <b>${IDP_LIVENESS}</b>, so the GTM answers ` +
              `<b>100% ${answered}</b> and the 50/50 is overridden. The edge stamps <b>${IDP_COOKIE_NAME}</b> from the answer.`
            : `No ${IDP_COOKIE_NAME} → the 50/50 lands on <b>${answered}</b>; the edge stamps ` +
              `<b>${IDP_COOKIE_NAME}</b> from the answer.`,
        answered === null ? 'bad' : overridden ? 'warn' : 'ok');
      if (answered === null) {
        return done('DOWN503',
          'GTM-ISAM has no healthy datacentre, so authentication cannot be served and the app stops here.',
          '503', { pinnedSite: pick, breakAt: 'gtm-isam' });
      }
      site = answered;
    }
    stampIdp(site);

    // Only a pinned request can reach a dead site: the GTM would have routed
    // a cookie-less one away from it.
    if (!idpReachable(state, site)) {
      const ltmOut = !!state.down[`idpltm-${site}`];
      return done('DOWN503',
        `${IDP_COOKIE_NAME} pinned ${site} and the ${site} ISAM IdP ` +
        (ltmOut ? 'LTM is out of service' : 'WGA tier is empty') +
        '. The cookie bypasses GTM-ISAM, so there is no failover — auth fails and the app stops here.',
        '503', { pinnedSite: site, breakAt: `idpltm-${site}` });
    }

    step([`idpltm-${site}`], `ISAM IdP LTM (${site})`,
      `VIP <b>${SITES[site].idpLtm}</b> → IdP WGA tier.`);
    step(idpWgaUp(state, site).map(i => `idpwga-${site}-${i}`), `ISAM IdP WGA (${site})`,
      'Authentication served.');

    const drainedIdp = !!idpPinned && state.idpLive[site] !== 'present';
    const idpKey: OutcomeKey = drainedIdp ? 'DRAINED' : idpPinned ? 'OK' : 'NEW';
    const idpWhy = drainedIdp
      ? `${IDP_COOKIE_NAME} pins ${site}, so the renamed ${IDP_LIVENESS} is never read. Auth is still ` +
        'served on the site being drained — it bleeds rather than cuts.'
      : idpPinned
        ? `${IDP_COOKIE_NAME} pins ${site} and the IdP tier is healthy. Independent of ${SITE_COOKIE_NAME} — ` +
          'auth and app calls on different sites is fine.'
        : `No ${IDP_COOKIE_NAME}. GTM-ISAM assigns ${site} and the edge stamps ${IDP_COOKIE_NAME}=${site}.`;

    return done(idpKey, idpWhy, '200 OK', { pinnedSite: site });
  }

  // ---- apis.bmo.com from the CIAM Auth SPAs: no cookie, GTM every time ---
  if (state.path === 'spaapi') {
    step(['ciam-spa'], 'CIAM Auth SPA',
      'Request <b>apis.bmo.com/api/*</b> (e.g. client-data-encryption-key/get). No affinity ' +
      'cookie — the property has no stickiness rule for apis.bmo.com.');

    const pick = state.gtmPick.spa;
    const answered = gtmAnswer.spa;
    const overridden = answered !== null && answered !== pick;
    step(['gtm-spa'], 'Akamai GTM-Auth-SPA-API',
      answered === null
        ? 'TCP:443 fails against the APIC farm on <b>both</b> sites.'
        : overridden
          ? `TCP:443 fails against APIC-${pick}, so the GTM answers <b>100% ${answered}</b>. ` +
            'With no cookie to pin it, every user fails over — existing ones included.'
          : `The 50/50 lands on <b>${answered}</b>. Nothing is stamped, so the next call gets its own answer.`,
      answered === null ? 'bad' : overridden ? 'warn' : 'ok');

    if (answered === null) {
      return done('DOWN503',
        'The APIC farm is out of service on both sites, so GTM-Auth-SPA-API has no healthy ' +
        'datacentre. Login cannot continue.',
        '503', { pinnedSite: pick, breakAt: 'gtm-spa' });
    }

    step([`apicfs-${answered}`], `APIC FS (${answered})`,
      `Routes into the ${answered} APIC farm — <b>${SITES[answered].apicFs}</b>.`);
    step(apicUp(state, answered).map(i => `apic-${answered}-${i}`), `APIC inst (${answered})`,
      'Forwards to SSS V2 through <b>es-api.bmogc.net</b>.');

    // CWH APIC calls SSS V2 through the es-api GSS, on the /api route. That GSS
    // fails over, so this only breaks when neither site's SSS V2 is healthy or
    // the shared AWS tier is out.
    const ds = downstreamRoute(state, `cwhapic-${answered}`, answered, 'gss', SSS_GSS_HOSTNAME, '/api');
    const front = overridden
      ? `APIC-${pick} is down, so the GTM sent this call to ${answered}. No cookie means no pin to ` +
        'hold it on the dead site — the failover just works.'
      : `No affinity cookie. GTM-Auth-SPA-API answers ${answered} for this request only.`;
    const extra = { pinnedSite: answered, apicSite: answered, downstream: [ds] };

    if (ds.status === 'broken') {
      const where = ds.breakAt === 'gss-es'
        ? 'neither site has a healthy SSS V2 (F5 and APIC) behind es-api'
        : ds.breakAt === 'awsgw' ? 'the AWS API Gateway is out' : 'every Lambda is out';
      return done('DS500',
        `CWH APIC served the request but cannot complete it: ${where}. Login cannot continue.`,
        '500', { ...extra, breakAt: ds.breakAt });
    }
    if (ds.status === 'failover') {
      return done('DS_FAILOVER',
        `${front} es-api's pick is down, so SSS V2 is reached on ${ds.site} instead — served, but cross-site.`,
        '200 OK', extra);
    }
    return done('OK', front, '200 OK', extra);
  }

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
      `VIP <b>${SITES[pinned].isamLtm}</b> → WGA tier. No liveness object and no port check — ` +
      'the ISAM flow is bound strictly by the cookie.');

    const wgaIds = wgas.map(i => `wga-${pinned}-${i}`);

    // The WGA junction call-back URL is the BOS LTM VIP hostname, so whatever
    // that VIP does to a connection, it does to ISAM. ISAM has no health
    // checking of its own — no liveness object, no port check — but that only
    // means it cannot *know* why it was refused, not that it is exempt. Both a
    // dead site and a pool emptied by DACT-104 surface as a 500.
    const poolOff = !ltmPoolUp(state, pinned);
    const bosRefused = !reachable(state, pinned) || poolOff;
    if (bosRefused) {
      const why = poolOff && reachable(state, pinned)
        ? `the ${pinned} BOS LTM pool is empty — DACT-104 has the monitor watching the liveness ` +
          'object, so the rename marked every member offline and the VIP refuses the junction'
        : `${pinned} BOS is down and legacy ISAM has no failover leg of its own`;
      step(wgaIds, `ISAM WGA (${pinned})`,
        `The junction is hard-wired to same-site BOS — <b>${SITES[pinned].ltmHost}</b>. ` +
        `Here ${why}, so <b>initISAMSession</b> fails.`, 'bad');
      return done('ISAM500',
        `${SITE_COOKIE_NAME} pinned ${pinned} ISAM, whose junction reaches only ${pinned} BOS, and ` +
        `${why}. Legacy ISAM shares the cookie with APIC but not APIC's failover, so it cannot ` +
        `reach ${other(pinned)} BOS the way the /api/cdb path can.`,
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
  // The clone ID is matched against plugin-cfg.xml, so what matters is which
  // site *issued* the JSESSIONID, not which site the cdbbossiteId points at.
  // Those are the same in manual mode but diverge after a failover: cookie SCC
  // with a BCC-issued session resolves fine as long as the request lands on BCC.
  const jsSite = state.jsessionSite ?? pinned;
  const crossSite = existing && bosSite !== jsSite;
  const jvmGone = existing && !crossSite && apps.indexOf(state.jsession) < 0;
  const appServer = crossSite || jvmGone || !existing ? apps[0] : state.jsession;

  let key: OutcomeKey;
  let why: string;

  if (crossSite && !SESSION_REPLICATED) {
    key = 'TIMEOUT';
    why = `JSESSIONID was issued by ${jsSite} App Server ${state.jsession}. That clone ID is not ` +
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

  // Only /api/cdb/* reaches the CDBBOS code that calls SSS V2, and a bounced
  // session never gets that far.
  const downstream = key === 'TIMEOUT' || !state.fanout ? [] : cdbbosDownstream(state, bosSite);

  // One real request hits one endpoint, and so one of these routes. The step
  // stands for all of them, so a broken route means some endpoints return 500
  // (CDBBOS cannot reach SSS V2) even though the front path served it.
  const brokenDs = downstream.filter(d => d.status === 'broken');
  const failedOver = downstream.filter(d => d.status === 'failover');
  const named = (ds: typeof downstream) =>
    ds.map(d => `${d.example} (${d.host})`).join(' and ');
  let http = key === 'TIMEOUT' ? '302 → login' : '200 OK';
  if (brokenDs.length) {
    const note = `${brokenDs.length} of ${downstream.length} downstream routes are broken: ` +
      `${named(brokenDs)} ${brokenDs.length > 1 ? 'have' : 'has'} no healthy SSS V2 to reach, ` +
      'so those endpoints return 500.';
    if (key === 'OK' || key === 'NEW') { key = 'PARTIAL'; why = note; } else { why += ` ${note}`; sevOverride = 'bad'; }
    http = '200 / 500';
  } else if (failedOver.length) {
    const note = `${named(failedOver)} failed over to the other site's SSS V2 — served, but cross-site.`;
    if (key === 'OK' || key === 'NEW') { key = 'DS_FAILOVER'; why = note; } else { why += ` ${note}`; }
  }

  return done(key, why, http, {
    apicSite,
    bosSite,
    appServer,
    setCookie,
    breakAt: key === 'TIMEOUT' ? `app-${bosSite}-${appServer}` : null,
    downstream
  });
}