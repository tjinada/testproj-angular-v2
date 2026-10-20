import type { QaEndpoint, QaEndpointGroup } from './qa-topology';

/** [METHOD] /path [notes] — the path stops at whitespace, ',' or '|'. */
const LINE = /^(?:([A-Za-z]+)[\s,|]+)?(\/[^\s,|]*)(?:[\s,|]+(.*))?$/;

/** Leading list markers Copilot tends to add anyway: '- ', '* ', '• ', '1. ', '1) '. */
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;

export function endpoints(text: string): QaEndpointGroup[] {
  const groups: QaEndpointGroup[] = [];
  const seen = new Set<string>();
  let current: QaEndpointGroup | null = null;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;

    if (line.startsWith('#')) {
      current = { title: line.replace(/^#+\s*/, '') || 'Endpoints', endpoints: [] };
      groups.push(current);
      return;
    }

    const m = LINE.exec(line.replace(LIST_MARKER, ''));
    if (!m) {
      console.warn(`[qa-endpoints] line ${i + 1} skipped, expected "METHOD /path | notes": ${line}`);
      return;
    }

    const ep: QaEndpoint = { method: (m[1] ?? 'ANY').toUpperCase(), path: m[2] };
    const notes = (m[3] ?? '').replace(/^[\s,|]+/, '').trim();
    if (notes) ep.notes = notes;

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

/**
 * Shared across every QA environment (same code is deployed everywhere).
 * An environment overrides a node's list in qa-environments.ts only where it differs.
 * Keys are node ids from qa-topology.ts.
 */
export const QA_SHARED_ENDPOINTS: Record<string, QaEndpointGroup[]> = {
  spa: endpoints(`
    # CIAM
    GET  /isvaop/oauth2/authorize       | Steps 1 & 5 · 401 then 200 + code
    POST /isvaop/oauth2/token           | Step 7 · code + PKCE verifier + DPoP
    GET  /login/cdb/ciam_mfe.js         | Step 2 · Authenticator MFE bundle
    GET  /banking/digital/ciam-callback | Step 6 · redirect target

    # CDB (via Akamai GSS rules)
    POST /api/cdb-ui/contact-handler/session/initCDBSession | Step 8 · creates CDB session
  `),

  bos: endpoints(`
    # /banking/services
    POST /banking/services/csgcb/session/initISAMSession | Legacy ISAM session
  `),

  sss1: endpoints(`
    # /api/cdb/<bian>/
  `),

  sss2: endpoints(`
    # /api/<bian>/
  `)
};
