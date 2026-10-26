import { QA_ROUTES } from './qa-topology';
import type { QaEndpoint, QaEndpointGroup } from './qa-topology';

/** [METHOD] /path [notes] — the path stops at whitespace, ',' or '|'. */
const LINE = /^(?:([A-Za-z]+)[\s,|]+)?(\/[^\s,|]*)(?:[\s,|]+(.*))?$/;

/** '# Title @route-id' — the optional tag names the QA_ROUTES route these calls travel. */
const HEADING = /^#+\s*(.*?)(?:\s+@([\w-]+))?\s*$/;

/** Leading list markers Copilot tends to add anyway: '- ', '* ', '• ', '1. ', '1) '. */
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;

/** One "[METHOD] /path | notes" line, or null if it isn't one. */
export function endpointLine(line: string): QaEndpoint | null {
  const m = LINE.exec(line.trim().replace(LIST_MARKER, ''));
  if (!m) return null;
  const ep: QaEndpoint = { method: (m[1] ?? 'ANY').toUpperCase(), path: m[2] };
  const notes = (m[3] ?? '').replace(/^[\s,|]+/, '').trim();
  if (notes) ep.notes = notes;
  return ep;
}

export function endpoints(text: string): QaEndpointGroup[] {
  const groups: QaEndpointGroup[] = [];
  let current: QaEndpointGroup | null = null;
  let seen = new Set<string>();   // per group: the same call may sit under several groups

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;

    if (line.startsWith('#')) {
      const [, title, route] = HEADING.exec(line)!;
      current = { title: title || 'Endpoints', endpoints: [] };
      if (route) current.route = route;
      groups.push(current);
      seen = new Set();
      return;
    }

    const ep = endpointLine(line);
    if (!ep) {
      console.warn(`[qa-endpoints] line ${i + 1} skipped, expected "METHOD /path | notes": ${line}`);
      return;
    }

    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (!current) {
      current = { title: 'Endpoints', endpoints: [] };
      groups.push(current);
    }
    current.endpoints.push(ep);
  });

  return groups.filter(g => g.endpoints.length > 0);
}

/*
 * Each list is what that component CALLS, grouped by where the call goes.
 * Lists shared between a caller and the box it calls (CDBBOS -> SSS lanes,
 * CDBBOS -> Midtier) are declared once and reused, so they cannot drift.
 * Paste one endpoint per line under a heading: [METHOD] /path | notes
 * (method is optional, defaults to ANY). Headings with no lines are hidden.
 *
 * Routes: tag a heading '@route-id' (a QA_ROUTES id) to say where its calls go.
 * SPA groups need no tag: CWH APIC decides from the path (see qa-rewrites.ts).
 * Untagged groups on other boxes trace to that box only.
 */

const BOS_TO_SSS_CDB = endpoints(`
  # CDBBOS → SSS /api/cdb (Channels) @cdbbos-channels
`);

const BOS_TO_SSS_API = endpoints(`
  # CDBBOS → SSS /api (DigitalCore) @cdbbos-digitalcore
`);

const BOS_TO_MIDTIER = endpoints(`
  # CDBBOS → Midtier @cdbbos-midtier
`);

/**
 * Shared across every QA environment (same code is deployed everywhere).
 * An environment overrides a node's list in qa-environments.ts only where it differs.
 * Keys are node ids from qa-topology.ts.
 */
export const QA_SHARED_ENDPOINTS: Record<string, QaEndpointGroup[]> = {
  spa: endpoints(`
    # CIAM · IdP @signin-idp

    # CIAM · MFE bundle @signin-mfe

    # CIAM · callback @spa-wem

    # CDB (via Akamai GSS rules)

    # /banking/services → CDBBOS

    # Legacy ISAM @legacy-isam
  `),

  bos: [
    ...BOS_TO_SSS_CDB,
    ...BOS_TO_SSS_API,
    ...BOS_TO_MIDTIER,
    ...endpoints(`
      # CDBBOS → HUB / CGSG

      # CDBBOS → DIAS cheque images

      # CDBBOS → RSA adaptive authentication
    `)
  ],

  sss1: BOS_TO_SSS_CDB,
  sss2: BOS_TO_SSS_API,
  mid: BOS_TO_MIDTIER
};

// Catch route-tag typos early.
const ROUTE_IDS = new Set(QA_ROUTES.map(r => r.id));
for (const g of Object.values(QA_SHARED_ENDPOINTS).flat()) {
  if (g.route && !ROUTE_IDS.has(g.route)) console.warn(`[qa-endpoints] "${g.title}": unknown route @${g.route}`);
}
