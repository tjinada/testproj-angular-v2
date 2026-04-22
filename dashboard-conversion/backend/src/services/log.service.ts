import https from 'https';
import http from 'http';
import readline from 'readline';
import { URL } from 'url';

// ── Types ────────────────────────────────────────────────────────────

export interface LogSearchRequest {
  logUrl: string;
  reqId: string;
}

/** One emitted line in the response. */
export interface LogLineOut {
  text: string;
  lineNum: number;
  isMatch: boolean;
}

/** Inserted between non-adjacent groups when rendered with context. */
export interface LogGap {
  gap: true;
  skipped: number;
}

export type LogEntry = LogLineOut | LogGap;

export interface LogSearchResponse {
  lines: LogEntry[];       // interleaved lines + gap markers
  totalMatched: number;    // total matching lines in file (uncapped count)
  matchesReturned: number; // matches actually included in `lines`
  truncated: boolean;      // true if we stopped streaming because of cap
  contextSize: number;     // the context size captured (fixed: MAX_CONTEXT)
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_MATCHED_LINES = 10_000;
const MAX_CONTEXT = 500;              // always captured; client slices smaller
const MAX_TOTAL_EMITTED = 200_000;    // hard safety cap on emitted lines (matches + context)
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
 * Fetches a remote log file, streams it line-by-line, and returns:
 *   - every line whose text contains `reqId` (a match), AND
 *   - up to MAX_CONTEXT lines of context before and after each match.
 *
 * Overlapping contexts are merged. Non-adjacent groups are separated
 * by a `{gap, skipped}` marker so the client can render "···".
 *
 * Caps matches at MAX_MATCHED_LINES. When the cap is hit, we still
 * continue counting matches (for `totalMatched`) but stop emitting.
 */
export async function searchLog(
  logUrl: string,
  reqId: string
): Promise<LogSearchResponse> {
  const parsed = new URL(logUrl);
  const transport = chooseTransport(parsed.protocol);
  const needle = reqId;

  const hasUser = !!process.env.LOG_SERVER_USERNAME;
  const hasPass = !!process.env.LOG_SERVER_PASSWORD;
  console.log(`[LogSearch] start — url=${logUrl}`);
  console.log(`[LogSearch] needle="${needle}" (length=${needle.length})`);
  console.log(`[LogSearch] creds present: username=${hasUser}, password=${hasPass}`);
  if (!hasUser || !hasPass) {
    console.warn('[LogSearch] WARNING: LOG_SERVER_USERNAME or LOG_SERVER_PASSWORD is empty');
  }

  const startedAt = Date.now();

  return new Promise<LogSearchResponse>((resolve, reject) => {
    const request = transport.get(
      logUrl,
      {
        headers: {
          Authorization: buildBasicAuthHeader(),
          Accept: 'text/plain, */*'
        },
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        const status = response.statusCode || 0;
        const contentType = response.headers['content-type'] || '<none>';
        const contentLength = response.headers['content-length'] || '<unknown>';
        console.log(`[LogSearch] response received — status=${status}, content-type=${contentType}, content-length=${contentLength}`);

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

        // ── Streaming state ──────────────────────────────────────────
        // ringBuf holds the last MAX_CONTEXT lines (for before-context).
        const ringBuf: { text: string; lineNum: number }[] = [];
        // Map lineNum -> LogLineOut for lines we've decided to emit.
        // Using a Map keyed by line number dedupes overlapping contexts.
        const emitted = new Map<number, LogLineOut>();
        // Countdown: when > 0, we keep adding upcoming lines as after-context.
        let afterCountdown = 0;
        let totalMatched = 0;
        let matchesReturned = 0;
        let truncated = false;
        let linesScanned = 0;
        let bytesReceived = 0;
        let firstLineSample: string | null = null;

        response.on('data', (chunk: Buffer) => {
          bytesReceived += chunk.length;
        });

        const rl = readline.createInterface({
          input: response,
          crlfDelay: Infinity
        });

        rl.on('line', (line) => {
          linesScanned += 1;
          if (firstLineSample === null) {
            firstLineSample = line.length > 300 ? line.slice(0, 300) + '…' : line;
          }
          if (linesScanned % 50_000 === 0) {
            console.log(`[LogSearch] progress — scanned=${linesScanned} lines, ${bytesReceived} bytes, matches=${totalMatched}`);
          }

          const isMatch = line.indexOf(needle) !== -1;

          if (isMatch) {
            totalMatched += 1;

            if (matchesReturned < MAX_MATCHED_LINES && emitted.size < MAX_TOTAL_EMITTED) {
              matchesReturned += 1;

              // Emit the before-context from the ring buffer.
              for (const buffered of ringBuf) {
                if (!emitted.has(buffered.lineNum) && emitted.size < MAX_TOTAL_EMITTED) {
                  emitted.set(buffered.lineNum, {
                    text: buffered.text,
                    lineNum: buffered.lineNum,
                    isMatch: false
                  });
                }
              }
              // Emit the match itself.
              emitted.set(linesScanned, {
                text: line,
                lineNum: linesScanned,
                isMatch: true
              });
              afterCountdown = MAX_CONTEXT;

              if (matchesReturned >= MAX_MATCHED_LINES && !truncated) {
                truncated = true;
                console.log(`[LogSearch] match cap reached (${MAX_MATCHED_LINES}); continuing to count but not emit`);
              }
              if (emitted.size >= MAX_TOTAL_EMITTED && !truncated) {
                truncated = true;
                console.log(`[LogSearch] emitted-lines safety cap reached (${MAX_TOTAL_EMITTED}); stopping emission`);
              }
            }
            // else: cap reached — we still count totalMatched, but skip emission.
          } else if (afterCountdown > 0 && emitted.size < MAX_TOTAL_EMITTED) {
            // Non-match, but inside after-context window of a prior match.
            if (!emitted.has(linesScanned)) {
              emitted.set(linesScanned, {
                text: line,
                lineNum: linesScanned,
                isMatch: false
              });
            }
            afterCountdown -= 1;
          }

          // Update the ring buffer (slide window).
          ringBuf.push({ text: line, lineNum: linesScanned });
          if (ringBuf.length > MAX_CONTEXT) {
            ringBuf.shift();
          }
        });

        rl.on('close', () => {
          const elapsedMs = Date.now() - startedAt;
          console.log(`[LogSearch] done — scanned=${linesScanned} lines, ${bytesReceived} bytes, totalMatched=${totalMatched}, returned=${matchesReturned}, truncated=${truncated}, elapsed=${elapsedMs}ms`);
          if (totalMatched === 0 && linesScanned > 0) {
            console.log(`[LogSearch] ZERO MATCHES. Sample of first line scanned: ${firstLineSample || '<none captured>'}`);
          }

          // Convert the emitted Map into a sorted array, inserting gap
          // markers wherever there's a jump in lineNum > 1.
          const sorted = Array.from(emitted.values()).sort((a, b) => a.lineNum - b.lineNum);
          const result: LogEntry[] = [];
          for (let i = 0; i < sorted.length; i++) {
            if (i > 0) {
              const prev = sorted[i - 1].lineNum;
              const curr = sorted[i].lineNum;
              if (curr - prev > 1) {
                result.push({ gap: true, skipped: curr - prev - 1 });
              }
            }
            result.push(sorted[i]);
          }

          resolve({
            lines: result,
            totalMatched,
            matchesReturned,
            truncated,
            contextSize: MAX_CONTEXT
          });
        });

        rl.on('error', (err) => {
          console.error(`[LogSearch] readline error: ${err.message}`);
          reject(err);
        });
      }
    );

    request.on('timeout', () => {
      console.error(`[LogSearch] request timeout after ${REQUEST_TIMEOUT_MS}ms for ${logUrl}`);
      request.destroy(new Error(`Request to ${logUrl} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    request.on('error', (err) => {
      console.error(`[LogSearch] request error: ${err.message}`);
      reject(err);
    });
  });
}
