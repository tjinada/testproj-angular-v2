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
