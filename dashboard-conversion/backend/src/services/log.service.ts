import https from 'https';
import http from 'http';
import readline from 'readline';
import { URL } from 'url';

// ── Types ────────────────────────────────────────────────────────────

export interface LogSearchRequest {
  logUrl: string;
  reqId: string;
}

export interface LogSearchResponse {
  lines: string[];
  totalMatched: number;
  truncated: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_MATCHED_LINES = 500;
const REQUEST_TIMEOUT_MS = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────

function buildBasicAuthHeader(): string {
  const username = process.env.LOG_SERVER_USERNAME || '';
  const password = process.env.LOG_SERVER_PASSWORD || '';
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

function chooseTransport(protocol: string): typeof https | typeof http {
  return protocol === 'https:' ? https : http;
}

// ── Main entry ───────────────────────────────────────────────────────

/**
 * Fetches a remote log file, streams it line-by-line, and returns lines
 * containing `REQID=<reqId>`. Caps matches at MAX_MATCHED_LINES.
 *
 * Rejects only on network / auth failures; an empty match set is a
 * successful response with `lines: []`.
 */
export async function searchLog(
  logUrl: string,
  reqId: string
): Promise<LogSearchResponse> {
  const parsed = new URL(logUrl);
  const transport = chooseTransport(parsed.protocol);
  // Plain substring match on the user's input. Log format varies
  // across services (REQID=[REQ_xxx], "rqUID":"REQ_xxx", etc.), so
  // we search for the raw value anywhere on the line.
  const needle = reqId;

  return new Promise<LogSearchResponse>((resolve, reject) => {
    const request = transport.get(
      logUrl,
      {
        headers: {
          Authorization: buildBasicAuthHeader(),
          Accept: 'text/plain, */*'
        },
        // File server uses a self-signed cert on an internal IP.
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        const status = response.statusCode || 0;

        if (status === 401 || status === 403) {
          response.resume();
          return reject(new Error(
            `Authentication failed (${status}). Check LOG_SERVER_USERNAME / LOG_SERVER_PASSWORD.`
          ));
        }

        if (status === 404) {
          response.resume();
          return reject(new Error(`Log file not found (404): ${logUrl}`));
        }

        if (status < 200 || status >= 300) {
          response.resume();
          return reject(new Error(`Log server returned HTTP ${status} for ${logUrl}`));
        }

        const matched: string[] = [];
        let totalMatched = 0;
        let truncated = false;

        const rl = readline.createInterface({
          input: response,
          crlfDelay: Infinity
        });

        rl.on('line', (line) => {
          if (line.indexOf(needle) === -1) return;
          totalMatched += 1;
          // (match is case-sensitive; REQ_ ids are always uppercase prefix)
          if (matched.length < MAX_MATCHED_LINES) {
            matched.push(line);
          } else if (!truncated) {
            truncated = true;
            // Stop reading further; we've hit the cap.
            rl.close();
            response.destroy();
          }
        });

        rl.on('close', () => {
          resolve({ lines: matched, totalMatched, truncated });
        });

        rl.on('error', (err) => {
          reject(err);
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Request to ${logUrl} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    request.on('error', (err) => {
      reject(err);
    });
  });
}
