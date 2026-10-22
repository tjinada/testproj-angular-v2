/**
 * CDBBOS fan-out — the outbound HTTP calls each CDBBOS operation makes, from a
 * static trace of the CDBBOS source (Copilot). Not a runtime capture.
 *
 * FORMAT (paste the trace output as-is):
 *   # POST /banking/services/transfers/sendCBT
 *   ANY /api/payment-initiation/cross-border-account-funds-transfer-instruction | Service.method · conditional
 *   // JDBC/database access: CbtDAOImpl.selectHarrisAccounts
 *
 * '# [METHOD] /path' is the operation as CDBBOS receives it (the CWH rewrite target).
 * Call lines are "[METHOD] /path | notes"; '· conditional' marks calls made only on
 * some code paths. '//' lines inside an operation are shown as "not on the diagram";
 * '//' lines before the first operation are ignored.
 *
 * DO NOT paste backticks (`) or '${' — this is a template literal.
 */
import type { QaEndpoint } from './qa-topology';
import { endpointLine } from './qa-endpoints';
import { normalizePath } from './qa-rewrites';

/** The box whose operations these are. */
export const FANOUT_NODE = 'bos';

/**
 * Route for a call that matches none of CDBBOS's own endpoint lists, by path prefix.
 * Anything else stays at CDBBOS.
 */
export const FANOUT_LANES: [prefix: string, route: string][] = [
  ['/api/cdb/', 'cdbbos-channels'],
  ['/api/', 'cdbbos-digitalcore']
];

export interface QaFanoutCall extends QaEndpoint {
  conditional: boolean;
}

export interface QaFanout {
  calls: QaFanoutCall[];
  /** JDBC, unresolved connectors and other non-HTTP notes. */
  other: string[];
}

const OPERATION = /^#+\s*(?:[A-Za-z]+\s+)?(\/\S*)/;
const CONDITIONAL = /\s*·?\s*\bconditional\b\s*$/i;

function fanout(text: string): Map<string, QaFanout> {
  const ops = new Map<string, QaFanout>();
  let current: QaFanout | null = null;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;

    if (line.startsWith('#')) {
      const m = OPERATION.exec(line);
      if (!m) {
        console.warn(`[qa-fanout] line ${i + 1} skipped, expected "# [METHOD] /path": ${line}`);
        current = null;
        return;
      }
      current = { calls: [], other: [] };
      ops.set(normalizePath(m[1]), current);
      return;
    }

    if (line.startsWith('//')) {
      current?.other.push(line.replace(/^\/\/\s*/, ''));
      return;
    }

    const ep = endpointLine(line);
    if (!ep || !current) {
      console.warn(`[qa-fanout] line ${i + 1} skipped, expected a call under an operation: ${line}`);
      return;
    }
    const conditional = CONDITIONAL.test(ep.notes ?? '');
    const notes = (ep.notes ?? '').replace(CONDITIONAL, '').trim();
    if (current.calls.some(c => c.method === ep.method && c.path === ep.path)) return;
    current.calls.push({ method: ep.method, path: ep.path, conditional, ...(notes ? { notes } : {}) });
  });

  return ops;
}

/** Keyed by the operation's normalised path, e.g. /banking/services/transfers/sendCBT. */
export const CDBBOS_FANOUT: Map<string, QaFanout> = fanout(`
`);
