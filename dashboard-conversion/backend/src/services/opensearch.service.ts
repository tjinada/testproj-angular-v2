import https from 'https';
import { URL } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ── Types ────────────────────────────────────────────────────────────

export interface OpenSearchTestRequest {
  searchTerm: string;
}

export interface OpenSearchTestResponse {
  /** Raw JSON body from AWS OpenSearch, unmodified. */
  raw: unknown;
  /** Status code returned by OpenSearch. */
  status: number;
  /** Milliseconds spent on the HTTP call. */
  elapsedMs: number;
  /** The URL we hit (for debugging; cookie excluded). */
  url: string;
}

// ── Constants ────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const TIME_RANGE_MS = 60 * 60 * 1000; // Last 1 hour — hardcoded per design
const SEARCH_PATH = '/_dashboards/internal/search/opensearch';

// ── Proxy setup ──────────────────────────────────────────────────────
// Only activated when PROXY_TARGET is configured. Uses the shared corporate
// proxy credentials (PROXY_USERNAME / PROXY_PASSWORD). Built once at module
// load so all calls share the same agent.

const proxyAgent: HttpsProxyAgent<string> | null = (() => {
  const target = process.env.PROXY_TARGET;
  if (!target) {
    console.log('[OpenSearch] PROXY_TARGET not set — requests will go direct');
    return null;
  }

  // Credentials in .env are already URL-encoded, so do NOT encode again.
  const username = process.env.PROXY_USERNAME || '';
  const password = process.env.PROXY_PASSWORD || '';
  const creds = username ? `${username}:${password}@` : '';
  const proxyUrl = `http://${creds}${target}`;

  console.log(`[OpenSearch] Proxy configured: target=${target}, user=${username ? username : '(none)'}`);
  return new HttpsProxyAgent(proxyUrl);
})();

// ── Main entry ───────────────────────────────────────────────────────

/**
 * Hits the AWS OpenSearch Dashboards internal search endpoint with the
 * user's search term. Authentication is via a fixed cookie pulled from
 * `.env` (OPENSEARCH_COOKIE). Routes through the corporate proxy when
 * PROXY_TARGET is set.
 *
 * This is a TEST feature — returns the raw response for display.
 */
export async function searchOpenSearch(
  searchTerm: string
): Promise<OpenSearchTestResponse> {
  const baseUrl = process.env.OPENSEARCH_URL || '';
  const cookie = process.env.OPENSEARCH_COOKIE || '';
  const indexPattern = process.env.OPENSEARCH_INDEX || 'channels-olb-*';

  console.log(`[OpenSearch] ────── NEW SEARCH ──────`);
  console.log(`[OpenSearch] env check: OPENSEARCH_URL=${baseUrl ? 'set (' + baseUrl.length + ' chars)' : 'MISSING'}`);
  console.log(`[OpenSearch] env check: OPENSEARCH_COOKIE=${cookie ? 'set (' + cookie.length + ' chars)' : 'MISSING'}`);
  console.log(`[OpenSearch] env check: OPENSEARCH_INDEX=${indexPattern}`);

  if (!baseUrl) {
    throw new Error('OPENSEARCH_URL is not set in .env');
  }
  if (!cookie) {
    throw new Error('OPENSEARCH_COOKIE is not set in .env');
  }

  const now = Date.now();
  const from = new Date(now - TIME_RANGE_MS).toISOString();
  const to = new Date(now).toISOString();

  const requestBody = buildQueryBody(searchTerm, indexPattern, from, to);

  const fullUrl = baseUrl.replace(/\/+$/, '') + SEARCH_PATH;
  const parsed = new URL(fullUrl);

  console.log(`[OpenSearch] POST ${fullUrl}`);
  console.log(`[OpenSearch] hostname=${parsed.hostname}, port=${parsed.port || 443}, path=${parsed.pathname}`);
  console.log(`[OpenSearch] index="${indexPattern}", term="${searchTerm}"`);
  console.log(`[OpenSearch] timeframe ${from} → ${to}`);
  console.log(`[OpenSearch] proxy=${proxyAgent ? 'yes' : 'no'}`);
  console.log(`[OpenSearch] request body size: ${JSON.stringify(requestBody).length} bytes`);

  const started = Date.now();

  return new Promise<OpenSearchTestResponse>((resolve, reject) => {
    const bodyStr = JSON.stringify(requestBody);

    const options: https.RequestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'osd-xsrf': 'true',
        'Cookie': cookie
      },
      timeout: REQUEST_TIMEOUT_MS,
      // Bypass TLS cert verification. Needed when routing through a
      // corporate proxy that performs TLS inspection (re-signs certs
      // with a private CA not in Node's default trust store).
      rejectUnauthorized: false,
      ...(proxyAgent && { agent: proxyAgent })
    };

    const req = https.request(options, (res) => {
      console.log(`[OpenSearch] response status ${res.statusCode} received, headers:`, {
        'content-type': res.headers['content-type'],
        'content-length': res.headers['content-length'],
        'set-cookie': res.headers['set-cookie'] ? '(present, ' + (res.headers['set-cookie'] as string[]).length + ' cookies)' : '(none)',
        'location': res.headers['location'],
        'www-authenticate': res.headers['www-authenticate']
      });

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const elapsedMs = Date.now() - started;
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        const status = res.statusCode || 0;

        console.log(`[OpenSearch] response complete: ${status} in ${elapsedMs}ms, ${bodyText.length} bytes`);

        // Log the first chunk of the body for debugging (max 500 chars)
        const preview = bodyText.length > 500
          ? bodyText.substring(0, 500) + `... (${bodyText.length - 500} more chars)`
          : bodyText;
        console.log(`[OpenSearch] response body preview:`);
        console.log(preview);

        // Try to parse the response as JSON; if not, return the text in
        // a wrapper so the caller still gets something useful.
        let raw: unknown;
        try {
          raw = JSON.parse(bodyText);
          // Summary for JSON responses:
          const r: any = raw;
          if (r?.rawResponse?.hits) {
            console.log(`[OpenSearch] parsed: hits.total=${r.rawResponse.hits.total?.value ?? r.rawResponse.hits.total}, returned=${r.rawResponse.hits.hits?.length ?? 0}, took=${r.rawResponse.took}ms`);
          } else if (r?.hits) {
            console.log(`[OpenSearch] parsed: hits.total=${r.hits.total?.value ?? r.hits.total}, returned=${r.hits.hits?.length ?? 0}, took=${r.took}ms`);
          } else if (r?.statusCode || r?.error) {
            console.log(`[OpenSearch] parsed as error: statusCode=${r.statusCode}, error=${typeof r.error === 'string' ? r.error : JSON.stringify(r.error)?.substring(0, 200)}`);
          } else {
            console.log(`[OpenSearch] parsed JSON but unexpected shape. Top-level keys: ${Object.keys(r || {}).join(', ')}`);
          }
        } catch (parseErr: any) {
          console.log(`[OpenSearch] response is NOT valid JSON: ${parseErr.message}`);
          raw = { nonJsonResponse: bodyText };
        }

        console.log(`[OpenSearch] ────── END SEARCH ──────`);

        if (status < 200 || status >= 300) {
          // Non-2xx: still resolve so the frontend can display the raw
          // response (useful for debugging auth/403/etc).
          return resolve({ raw, status, elapsedMs, url: fullUrl });
        }

        resolve({ raw, status, elapsedMs, url: fullUrl });
      });
    });

    req.on('timeout', () => {
      console.error(`[OpenSearch] TIMEOUT after ${REQUEST_TIMEOUT_MS}ms`);
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', (err: any) => {
      console.error(`[OpenSearch] request error: ${err.message} (code=${err.code || 'unknown'})`);
      if (err.code === 'ENOTFOUND') {
        console.error(`[OpenSearch] DNS lookup failed — hostname unreachable`);
      } else if (err.code === 'ECONNREFUSED') {
        console.error(`[OpenSearch] Connection refused — server not listening or proxy rejected`);
      } else if (err.code === 'ETIMEDOUT') {
        console.error(`[OpenSearch] Connection timed out — likely firewall block`);
      } else if (err.code === 'ECONNRESET') {
        console.error(`[OpenSearch] Connection reset — server or proxy closed connection mid-request`);
      }
      reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Query builder ────────────────────────────────────────────────────

/**
 * Builds the OpenSearch Dashboards internal-search request body. Matches
 * the shape captured from a working Postman call (query_string with
 * analyze_wildcard, timestamp range filter, size=10000, sort desc).
 */
function buildQueryBody(
  searchTerm: string,
  indexPattern: string,
  from: string,
  to: string
): Record<string, unknown> {
  return {
    params: {
      index: indexPattern,
      body: {
        version: true,
        size: 10000,
        sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'boolean' } }],
        aggs: {
          '2': {
            date_histogram: {
              field: '@timestamp',
              calendar_interval: '1m',
              time_zone: 'Canada/Eastern',
              min_doc_count: 1
            }
          }
        },
        stored_fields: ['*'],
        script_fields: {},
        docvalue_fields: [
          { field: '@timestamp', format: 'date_time' },
          { field: 'esTimestamp', format: 'date_time' },
          { field: 'fbTimestamp', format: 'date_time' }
        ],
        _source: { excludes: [] },
        query: {
          bool: {
            must: [],
            filter: [
              {
                query_string: {
                  query: searchTerm,
                  analyze_wildcard: true,
                  time_zone: 'Canada/Eastern'
                }
              },
              {
                range: {
                  '@timestamp': {
                    gte: from,
                    lte: to,
                    format: 'strict_date_optional_time'
                  }
                }
              }
            ],
            should: [],
            must_not: []
          }
        },
        preference: Date.now()
      }
    }
  };
}
