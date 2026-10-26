/**
 * SSS V2 APIC /api/cdb routes — which microservice each /api/cdb call reaches.
 * Used for calls CDBBOS sends to SSS /api/cdb and for client calls CWH passes
 * through unchanged. One table per environment (targets differ per SIT).
 *
 * FORMAT (paste the Copilot output as-is):
 *   # channels-ms-alert | api.olb-mob-ext-15255-qa2.external.venus.ocp4-qa.bmogc.net | OCP4
 *   ANY /api/cdb/service-product/alert-service/alert -> /channels-ms-alert | notes
 *
 * '# service | host | platform' starts a service; lines are
 * "[METHOD[/METHOD]] /api/cdb/... -> /target | notes". The incoming path is a prefix:
 * whatever follows it is appended to the target. '//' lines are ignored.
 *
 * DO NOT paste backticks (`) or '${' — this is a template literal.
 */
import { normalizePath, pathPattern } from './qa-rewrites';

export interface QaChannelRoute {
  service: string;
  host: string;
  platform: string;
  method: string;
  from: string;
  to: string;
  notes?: string;
}

/** Where each platform's services sit on the diagram. */
export const CHANNEL_PLATFORM_NODES: Record<string, string> = { OCP4: 'chan', AWS: 'awsgw' };

/** The route CDBBOS calls into SSS /api/cdb take before the table says where they land. */
export const CDBBOS_CHANNEL_ROUTE = 'cdbbos-channels';

/**
 * A call on one of these routes enters SSS /api/cdb; a table match swaps it for the
 * route to that platform. Keyed by the route the call would otherwise take.
 */
export const CHANNEL_LANE_ROUTES: Record<string, Record<string, string>> = {
  [CDBBOS_CHANNEL_ROUTE]: { OCP4: 'cdbbos-channels',      AWS: 'cdbbos-channels-aws' },
  'cwh-channels-aws':     { OCP4: 'cwh-channel-services', AWS: 'cwh-channels-aws' }
};

const ROUTE_LINE = /^(?:([A-Za-z]+(?:\/[A-Za-z]+)*)\s+)?(\/\S*)\s*->\s*(\/\S*)(?:\s*\|\s*(.*))?$/;

export function channelRoutes(text: string): QaChannelRoute[] {
  const out: QaChannelRoute[] = [];
  let service: Pick<QaChannelRoute, 'service' | 'host' | 'platform'> | null = null;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;

    if (line.startsWith('#')) {
      const parts = line.replace(/^#+\s*/, '').split('|').map(p => p.trim());
      service = { service: parts[0], host: parts.length > 2 ? parts[1] : '', platform: parts[parts.length - 1] };
      return;
    }

    const m = ROUTE_LINE.exec(line);
    if (!m || !service) {
      console.warn(`[qa-channel-routes] line ${i + 1} skipped, expected "[METHOD] /path -> /target | notes" under a '# service' heading: ${line}`);
      return;
    }
    out.push({
      ...service,
      method: (m[1] ?? 'ANY').toUpperCase(),
      from: normalizePath(m[2]),
      to: m[3],
      ...(m[4]?.trim() ? { notes: m[4].trim() } : {})
    });
  });
  return out;
}

/** The lane a route belongs to: the route a call enters it on, or one it resolved to. */
export function laneOf(route: string): Record<string, string> | undefined {
  return CHANNEL_LANE_ROUTES[route]
    ?? Object.values(CHANNEL_LANE_ROUTES).find(lane => Object.values(lane).includes(route));
}

/** The most specific route for a path, and the path the target receives. */
export function matchChannelRoute(routes: QaChannelRoute[], path: string): { route: QaChannelRoute; target: string } | null {
  const p = normalizePath(path);
  let best: { route: QaChannelRoute; target: string } | null = null;
  for (const route of routes) {
    const m = pathPattern(route.from, true).exec(p);
    if (m && (!best || route.from.length > best.route.from.length)) {
      best = { route, target: route.to.replace(/\/$/, '') + p.slice(m[0].length) };
    }
  }
  return best;
}

/** SIT2 APIC configuration — used by QA5. */
export const SIT2_CHANNEL_ROUTES: QaChannelRoute[] = channelRoutes(`
`);
