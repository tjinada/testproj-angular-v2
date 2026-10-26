/**
 * CWH APIC path rewrites — how a client call through CWH reaches its backend.
 *
 * Rule: a listed path is sent to CDBBOS as  /api/cdb/<domain>/<rest>  →  <base>/<rest>.
 * Any other /api/cdb/* call is passed on unchanged to SSS V2 /api/cdb → Channels AWS.
 *
 * FORMAT (paste-friendly): '# <base>' starts a block, then one /api/cdb path per line.
 *   # /banking/services
 *   /api/cdb/consumer-advisory-services/interstitial/enrollEstatement
 *
 * DO NOT paste backticks (`) or '${' — this is a template literal.
 */

/** The CWH APIC box, and the box it passes unmapped /api/cdb/* calls to. */
export const CWH_NODE = 'apic';
export const CWH_PASSTHROUGH_NODE = 'sss1';

/** QA_ROUTES ids for the two ways out of CWH. */
export const CWH_ROUTES = { cdbbos: 'cwh-cdbbos', passThrough: 'cwh-channels-aws' } as const;

export interface QaRewrite {
  from: string;
  to: string;
  base: string;
}

/** Host, query string and trailing '/' dropped; Akamai's /api{n}/cdb read as /api/cdb. */
export function normalizePath(input: string): string {
  const path = input.trim()
    .replace(/^[a-z]+:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/^\/api\d+\/cdb\//i, '/api/cdb/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * A catalogued path as a regex: '*' and '{name}' segments match any one segment.
 * With prefix, it also matches longer paths under it.
 */
export function pathPattern(pattern: string, prefix = false): RegExp {
  const segments = pattern.split('/').map(s =>
    s === '*' || /^\{[^}]+\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + segments.join('/') + (prefix ? '(?=/|$)' : '$'));
}

function rewrites(text: string): QaRewrite[] {
  const out: QaRewrite[] = [];
  let base = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    if (line.startsWith('#')) {
      base = line.replace(/^#+\s*/, '');
      return;
    }
    const from = normalizePath(line);
    if (!base || !from.startsWith('/api/cdb/')) {
      console.warn(`[qa-rewrites] line ${i + 1} skipped, expected an /api/cdb path under a '# <base>' heading: ${line}`);
      return;
    }
    const rest = from.split('/').slice(4).join('/');
    out.push({ from, base, to: `${base === '/' ? '' : base.replace(/\/$/, '')}/${rest}` });
  });
  return out;
}

export const CWH_REWRITES: QaRewrite[] = rewrites(`
  # /banking/services

  # /banking

  # /
`);

const BY_FROM = new Map(CWH_REWRITES.map(r => [r.from, r]));

/** Where a client call goes after CWH, or null when it doesn't go through CWH. */
export function cwhRoute(path: string): { route: string; to?: string } | null {
  const p = normalizePath(path);
  const hit = BY_FROM.get(p);
  if (hit) return { route: CWH_ROUTES.cdbbos, to: hit.to };
  if (p.startsWith('/api/cdb/')) return { route: CWH_ROUTES.passThrough };
  if (p.startsWith('/banking/services/')) return { route: CWH_ROUTES.cdbbos, to: p };
  return null;
}
