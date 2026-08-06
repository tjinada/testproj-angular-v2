import type { SimState, SiteId } from '../../models/traffic-flow.model';

/** Per-site hostnames and VIPs, transcribed from the CDB architecture diagram. */
export interface SiteFacts {
  apicFs: string;
  extGtm: string;
  ltmHost: string;
  ltmVip: string;
  /** Legacy ISAM front door. Note the .bmofg.com domain, not .bmo.com. */
  isamLtm: string;
}

export const SITE_IDS: SiteId[] = ['BCC', 'SCC'];

export const SITES: Record<SiteId, SiteFacts> = {
  BCC: {
    apicFs: 'bmonsori-apisbccprod.bmo.com',
    extGtm: 'bos-www13.bmo.com',
    ltmHost: 'bmonsori-www13.bmo.com',
    ltmVip: '(198.96.174.25)',
    isamLtm: 'retailcanapi-prodbcc.bmofg.com'
  },
  SCC: {
    apicFs: 'bmonsori-apissccprod.bmo.com',
    extGtm: 'bos-www12.bmo.com',
    ltmHost: 'bmonsori-www12.bmo.com',
    ltmVip: '(142.43.171.25)',
    isamLtm: 'retailcanapi-prodscc.bmofg.com'
  }
};

/** Name-server delegation shown on both EXT GTM nodes. */
export const NAME_SERVERS = [
  'NS: gss-bar-bcc.bmo.com',
  '(198.96.179.18)',
  'NS: gss-tor-scc.bmo.com',
  '(198.96.181.252)'
];

/** Tier cardinality, per the diagram. */
export const APIC_INSTANCES = 3;
export const WEB_SERVERS = 2;
export const APP_SERVERS = 6;
export const WGA_INSTANCES = 6;

/*
 * Environment facts, not operator controls. These describe how the estate is
 * actually configured; change them here when the configuration changes rather
 * than exposing them as toggles in the UI.
 */

/** httpd.conf accepts both bos-www12 and bos-www13 on both sites. */
export const VHOST_DEPLOYED = true;

/** WAS DRS / cross-site session persistence. BOS session state is site-local. */
export const SESSION_REPLICATED = false;

/**
 * The site-affinity cookie. Note the capital I: the architecture diagram's
 * "cdbbossiteid" is a typo — the property sets cdbbossiteId, and cookie names
 * are case-sensitive under RFC 6265.
 *
 * Values are <env>-<SITE>, e.g. blue-BCC, green-SCC, -BCC. The property matches
 * them as a *SITE* substring, not by equality.
 */
export const SITE_COOKIE_NAME = 'cdbbossiteId';

/** GTM fronting /api/cdb/*. Site affinity still comes from cdbbossiteId. */
export const API_GTM_HOSTNAME = 'wlb.apis.olbb.akadns.net';

/**
 * A request carrying a valid cdbbossiteId never reaches populate-cname-chain:
 * PMUSER_TARGET is assigned a hardcoded per-site hostname and the GTM is never
 * queried. Liveness is therefore not overridden — it is never consulted at all.
 * That is why renaming live.txt bleeds a site instead of cutting it, and why
 * there is no failover for a cookie-bearing request whose pinned origin is down.
 *
 * Verified against property prod.olb.com_pm v386, in which the strings
 * "live.txt" and "liveness" do not appear.
 */
export const COOKIE_BYPASSES_GTM = true;

/**
 * /banking/live.txt is a plain static file served by the httpd process in IHS,
 * and both GTMs probe the same object.
 *
 * It therefore says nothing about the app tier. Killing every JVM leaves it
 * returning 200, so neither GTM reacts and traffic keeps arriving at a site
 * that cannot serve it — which is exactly why the unplanned-outage runbook has
 * a manual "rename live.txt" step to force the drain.
 *
 * This corrects an earlier note in this file which had it served through the
 * WAS plugin and therefore app-aware. It is not.
 */
export const LIVE_TXT_STATIC_IN_IHS = true;

/**
 * Legacy ISAM keys off the same cdbbossiteId as APIC, but hard-wires to
 * same-site BOS with no failover leg of its own. The cookie therefore records
 * which *APIC* served the last call, and initISAMSession inherits that answer
 * as if it were a statement about BOS.
 *
 * When APIC fails over but BOS does not — SCC APIC forwarding to BCC BOS — the
 * edge stamps SCC from the APIC answer. The next /banking/services/csgcb call
 * pins SCC ISAM, which reaches only SCC BOS. If SCC BOS is the site that is
 * down, initISAMSession returns 500 even though the api path is being served
 * perfectly well by BCC.
 *
 * The two calls are separate requests, so the trap is armed by one and sprung
 * by the next. The api path forward-declares it on the SPLIT outcome rather
 * than pretending a single request can traverse both.
 */
export const ISAM_SHARES_SITE_COOKIE = true;

/**
 * Node ids the operator may take out of service by clicking the diagram.
 *
 * Only inline devices qualify — ones every packet passes through. The GTMs are
 * control plane: they answer a DNS question once and step aside, so taking one
 * out does not stop traffic. Verified 2026-07-31 that the two EXT GTM
 * appliances are a sync group answering identically for the same wide IPs,
 * which makes a single-appliance outage unobservable from the request path.
 */
export const TOGGLEABLE_NODE = /^(apicfs|apic|ltm|web|app|isamltm|wga)-/;

/** Starting scenario: healthy estate, existing session pinned to BCC. */
export function defaultSimState(): SimState {
  return {
    path: 'api',
    session: 'existing',
    site: 'BCC',
    gtmPick: { bos: 'BCC', api: 'BCC' },
    jsession: 1,
    live: { BCC: 'present', SCC: 'present' },
    ltmMonitor: 'live',
    extGtmMonitor: 'live',
    cookieSetBy: 'edge',
    down: {}
  };
}

/** Human label for a node id, used by the out-of-service list. */
export function nodeLabel(id: string): string {
  const parts = id.split('-');
  const tier: Record<string, string> = {
    apicfs: 'APIC FS',
    apic: 'APIC inst',
    extgtm: 'EXT GTM',
    ltm: 'BOS LTM',
    web: 'BOS Web',
    app: 'BOS App',
    isamltm: 'ISAM LTM',
    wga: 'ISAM WGA'
  };
  const name = tier[parts[0]] ?? parts[0];
  return `${name} ${parts[1] ?? ''}${parts[2] ? ' #' + parts[2] : ''}`.trim();
}
