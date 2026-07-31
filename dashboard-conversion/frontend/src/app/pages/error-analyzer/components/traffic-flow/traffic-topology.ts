import type { SimState, SiteId } from '../../models/traffic-flow.model';

/** Per-site hostnames and VIPs, transcribed from the CDB architecture diagram. */
export interface SiteFacts {
  apicFs: string;
  extGtm: string;
  ltmHost: string;
  ltmVip: string;
}

export const SITE_IDS: SiteId[] = ['BCC', 'SCC'];

export const SITES: Record<SiteId, SiteFacts> = {
  BCC: {
    apicFs: 'bmonsori-apisbccprod.bmo.com',
    extGtm: 'bos-www13.bmo.com',
    ltmHost: 'bmonsori-www13.bmo.com',
    ltmVip: '(198.96.174.25)'
  },
  SCC: {
    apicFs: 'bmonsori-apissccprod.bmo.com',
    extGtm: 'bos-www12.bmo.com',
    ltmHost: 'bmonsori-www12.bmo.com',
    ltmVip: '(142.43.171.25)'
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

/** Node ids the operator may take out of service by clicking the diagram. */
export const TOGGLEABLE_NODE = /^(apicfs|apic|extgtm|ltm|web|app)-/;

/** Starting scenario: healthy estate, existing session pinned to BCC. */
export function defaultSimState(): SimState {
  return {
    path: 'api',
    session: 'existing',
    site: 'BCC',
    jsession: 1,
    live: { BCC: 'present', SCC: 'present' },
    ltmMonitor: 'live',
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
    app: 'BOS App'
  };
  const name = tier[parts[0]] ?? parts[0];
  return `${name} ${parts[1] ?? ''}${parts[2] ? ' #' + parts[2] : ''}`.trim();
}
