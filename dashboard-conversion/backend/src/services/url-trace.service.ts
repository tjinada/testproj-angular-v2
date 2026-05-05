import axios, { AxiosResponse } from 'axios';

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

export interface UrlTraceResult {
  originalUrl: string;
  finalUrl: string;
  totalHops: number;
  hops: RedirectHop[];
  error: string | null;
}

const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Follows the HTTP redirect chain for a URL and returns each hop.
 * Tries HEAD first; falls back to GET on the same hop if the server
 * rejects HEAD with 405 or 501.
 *
 * `proxy: false` is set on every request so traffic goes direct (matches
 * the OpenSearch service pattern — corporate proxies otherwise interfere
 * with redirect inspection).
 */
export async function traceUrl(originalUrl: string): Promise<UrlTraceResult> {
  const hops: RedirectHop[] = [];
  let currentUrl = originalUrl;
  let error: string | null = null;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    let response: AxiosResponse;

    try {
      response = await requestHopWithFallback(currentUrl);
    } catch (err: any) {
      error = formatNetworkError(err, currentUrl);
      break;
    }

    const location = extractLocation(response, currentUrl);
    hops.push({
      url: currentUrl,
      status: response.status,
      location
    });

    // Terminal response: 2xx, 4xx, 5xx, or 3xx without a usable Location.
    if (!isRedirect(response.status) || !location) {
      return {
        originalUrl,
        finalUrl: currentUrl,
        totalHops: hops.length,
        hops,
        error: null
      };
    }

    currentUrl = location;
  }

  // Loop exited without returning => either an error mid-chain (already in
  // `error`) or we hit the max-redirect cap.
  if (!error && hops.length === MAX_REDIRECTS) {
    error = `Max redirects (${MAX_REDIRECTS}) exceeded`;
  }

  return {
    originalUrl,
    finalUrl: currentUrl,
    totalHops: hops.length,
    hops,
    error
  };
}

/**
 * Attempts HEAD first; if the server rejects HEAD (405 / 501), retries the
 * same URL with GET. Avoids downloading response bodies on most hops.
 */
async function requestHopWithFallback(url: string): Promise<AxiosResponse> {
  const config = {
    maxRedirects: 0,
    validateStatus: () => true, // we inspect 3xx/4xx/5xx ourselves
    timeout: REQUEST_TIMEOUT_MS,
    proxy: false as const
  };

  const headResponse = await axios.head(url, config);

  if (headResponse.status === 405 || headResponse.status === 501) {
    return axios.get(url, config);
  }

  return headResponse;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Resolves the Location header against the current URL. Handles absolute
 * URLs, protocol-relative URLs, and path-relative URLs. Returns null if
 * the header is missing or unparseable.
 */
function extractLocation(response: AxiosResponse, currentUrl: string): string | null {
  const raw = response.headers?.location;
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  try {
    return new URL(raw, currentUrl).toString();
  } catch {
    return null;
  }
}

function formatNetworkError(err: any, url: string): string {
  if (err?.code === 'ECONNABORTED') {
    return `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`;
  }
  if (err?.code === 'ENOTFOUND') {
    return `DNS lookup failed for ${url}`;
  }
  if (err?.code === 'ECONNREFUSED') {
    return `Connection refused by ${url}`;
  }
  if (err?.code) {
    return `${err.code}: ${err.message || 'request failed'} (${url})`;
  }
  return err?.message || `Request failed for ${url}`;
}
