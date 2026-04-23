import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import config from '../config';

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
// AWS OpenSearch is a public internet endpoint (*.amazonaws.com). Routing
// depends on where the backend runs:
//   - Local laptop: direct connection works (laptop has internet access).
//   - OpenShift pod: must go through the corporate proxy because the pod
//     has no direct egress.
//
// The env flag OPENSEARCH_PROXY_ENABLED picks the mode. When true, we
// build an HttpsProxyAgent using the shared `config.proxy` settings
// (same as dynatrace.service.ts). When false/unset, we go direct.

const proxyAgent: HttpsProxyAgent<string> | null = (() => {
  const enabled = process.env.OPENSEARCH_PROXY_ENABLED === 'true';
  if (!enabled) {
    console.log('[OpenSearch] OPENSEARCH_PROXY_ENABLED!=true — using direct connection');
    return null;
  }

  const target = config.proxy?.target;
  if (!target) {
    console.log('[OpenSearch] OPENSEARCH_PROXY_ENABLED=true but config.proxy.target is missing — falling back to direct');
    return null;
  }

  const username = config.proxy.username || '';
  const password = config.proxy.password || '';
  const proxyUrl = `http://${username}:${password}@${target}`;
  console.log(`[OpenSearch] Proxy enabled: target=${target}, user=${username ? username : '(none)'}`);
  return new HttpsProxyAgent(proxyUrl);
})();

/** Axios instance for OpenSearch API calls. Routes through the corporate proxy when configured. */
const httpClient = axios.create({
  // proxy: false explicitly disables axios's built-in proxy env-var detection.
  // When proxyAgent is present, use it via httpsAgent instead.
  ...(proxyAgent
    ? { httpsAgent: proxyAgent, proxy: false as const }
    : { proxy: false as const })
});

// ── Main entry ───────────────────────────────────────────────────────

/**
 * Hits the AWS OpenSearch Dashboards internal search endpoint with the
 * user's search term. Authentication is via a fixed cookie pulled from
 * `.env` (OPENSEARCH_COOKIE). Routes through the corporate proxy when
 * configured (via shared `config.proxy`).
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

  console.log(`[OpenSearch] POST ${fullUrl}`);
  console.log(`[OpenSearch] index="${indexPattern}", term="${searchTerm}"`);
  console.log(`[OpenSearch] timeframe ${from} → ${to}`);
  console.log(`[OpenSearch] proxy=${proxyAgent ? 'yes (corporate proxy)' : 'no (direct)'}`);
  console.log(`[OpenSearch] request body size: ${JSON.stringify(requestBody).length} bytes`);

  const started = Date.now();

  try {
    const response = await httpClient.post(
      fullUrl,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'osd-xsrf': 'true',
          'Cookie': cookie
        },
        timeout: REQUEST_TIMEOUT_MS,
        // Accept ANY status code so non-2xx responses (401, 403, 500)
        // flow back to the frontend for display instead of throwing.
        validateStatus: () => true
      }
    );

    const elapsedMs = Date.now() - started;
    const status = response.status;
    const bodyText = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    console.log(`[OpenSearch] response status ${status} received, headers:`, {
      'content-type': response.headers['content-type'],
      'content-length': response.headers['content-length'],
      'set-cookie': response.headers['set-cookie'] ? '(present)' : '(none)',
      'www-authenticate': response.headers['www-authenticate']
    });
    console.log(`[OpenSearch] response complete: ${status} in ${elapsedMs}ms, ${bodyText.length} bytes`);

    // Log the first chunk of the body for debugging (max 500 chars)
    const preview = bodyText.length > 500
      ? bodyText.substring(0, 500) + `... (${bodyText.length - 500} more chars)`
      : bodyText;
    console.log(`[OpenSearch] response body preview:`);
    console.log(preview);

    // Summarise parsed response
    const raw: any = response.data;
    if (raw?.rawResponse?.hits) {
      console.log(`[OpenSearch] parsed: hits.total=${raw.rawResponse.hits.total?.value ?? raw.rawResponse.hits.total}, returned=${raw.rawResponse.hits.hits?.length ?? 0}, took=${raw.rawResponse.took}ms`);
    } else if (raw?.hits) {
      console.log(`[OpenSearch] parsed: hits.total=${raw.hits.total?.value ?? raw.hits.total}, returned=${raw.hits.hits?.length ?? 0}, took=${raw.took}ms`);
    } else if (raw?.statusCode || raw?.error) {
      console.log(`[OpenSearch] parsed as error: statusCode=${raw.statusCode}, error=${typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error)?.substring(0, 200)}`);
    } else {
      console.log(`[OpenSearch] parsed JSON but unexpected shape. Top-level keys: ${Object.keys(raw || {}).join(', ')}`);
    }

    console.log(`[OpenSearch] ────── END SEARCH ──────`);

    return { raw, status, elapsedMs, url: fullUrl };
  } catch (err: any) {
    const elapsedMs = Date.now() - started;
    const code = err.code || 'unknown';
    console.error(`[OpenSearch] request failed after ${elapsedMs}ms: ${err.message} (code=${code})`);
    if (code === 'ENOTFOUND') {
      console.error(`[OpenSearch] DNS lookup failed — hostname unreachable`);
    } else if (code === 'ECONNREFUSED') {
      console.error(`[OpenSearch] Connection refused — server not listening or proxy rejected`);
    } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      console.error(`[OpenSearch] Connection timed out — likely firewall block or proxy hang`);
    } else if (code === 'ECONNRESET') {
      console.error(`[OpenSearch] Connection reset — server or proxy closed connection mid-request`);
    }
    console.log(`[OpenSearch] ────── END SEARCH (error) ──────`);
    throw err;
  }
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
            must: [{ match_all: {} }],
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
        }
      },
      preference: Date.now()
    }
  };
}
