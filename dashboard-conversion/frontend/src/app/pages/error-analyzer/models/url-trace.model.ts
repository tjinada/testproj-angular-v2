/**
 * Frontend types for the URL Trace tab. Mirrors the backend's shapes
 * returned by POST /api/url-trace/flow (see backend/src/services/
 * url-trace.service.ts → UrlTraceResult).
 *
 * Kept in sync with the backend manually — the two codebases don't
 * share a types package. When extending, change both.
 */

// ── Request ──────────────────────────────────────────────────────────

export interface UrlTraceRequest {
  url: string;
  /**
   * Optional headers forwarded on every hop. Cookies go in here too as
   * a `Cookie` header (e.g. { Cookie: "JSESSIONID=abc; theme=dark" }).
   * Keys are case-insensitive at the HTTP level but the server preserves
   * the casing the user typed.
   */
  headers?: Record<string, string>;
}

// ── Hop ──────────────────────────────────────────────────────────────

/**
 * One step in the redirect chain.
 *  - status:   HTTP status code observed at this URL.
 *  - location: the resolved Location header (absolute URL), or null when
 *              the response is not a redirect or no Location was sent.
 */
export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

// ── Top-level response ──────────────────────────────────────────────

/**
 * - originalUrl: the URL the user submitted.
 * - finalUrl:    the URL where the chain terminated (last hop's URL).
 * - totalHops:   number of HTTP requests made.
 * - hops:        every hop, in order.
 * - error:       null on success. Populated when the chain was aborted
 *                early (network failure, max-redirect cap). Partial hops
 *                are still returned in `hops` when error is non-null.
 */
export interface UrlTraceResponse {
  originalUrl: string;
  finalUrl: string;
  totalHops: number;
  hops: RedirectHop[];
  error: string | null;
}

// ── Error response (matches backend 400 / 500 shape) ────────────────

export interface UrlTraceError {
  error: string;
}

// ── Header parsing ──────────────────────────────────────────────────

/**
 * Parses a textarea blob into a header map. Each line is `Name: Value`.
 * Blank lines and `#`-prefixed lines are ignored. Returns the parsed
 * map and any per-line errors (so the UI can show "line 3: missing colon").
 */
export interface ParsedHeaders {
  headers: Record<string, string>;
  errors: string[];
}

export function parseHeaderBlob(raw: string): ParsedHeaders {
  const headers: Record<string, string> = {};
  const errors: string[] = [];

  if (!raw || raw.trim() === '') {
    return { headers, errors };
  }

  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) {
      errors.push(`Line ${idx + 1}: expected "Name: Value"`);
      return;
    }

    const name = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (name === '') {
      errors.push(`Line ${idx + 1}: header name is empty`);
      return;
    }

    headers[name] = value;
  });

  return { headers, errors };
}
