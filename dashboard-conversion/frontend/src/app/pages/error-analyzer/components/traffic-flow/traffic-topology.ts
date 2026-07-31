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
 * Akamai is an HTTP edge and can read cdbbossiteid, so an existing session can
 * stay pinned to its site even when that site's liveness object is gone — the
 * drain leaks. The EXT GTM answers DNS queries and can never do this: a
 * resolver carries no cookie, so health is the only input it has.
 */
export const EDGE_COOKIE_BEATS_LIVENESS = true;

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
