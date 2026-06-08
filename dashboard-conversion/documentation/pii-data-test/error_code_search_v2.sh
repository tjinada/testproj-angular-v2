#!/usr/bin/env bash
#
# fetch-errors.sh — fetch OpenSearch logs filtered by error code(s) and count
# occurrences. Configuration (endpoint + auth) comes from a .env file in the
# current directory.
#
# Usage:
#   ./fetch-errors.sh "CODE1,CODE2,..."                            # last 24h
#   ./fetch-errors.sh "SI/D/622" --hours 6                         # last 6h
#   ./fetch-errors.sh "SI/D/" --from 2026-06-07T00:00:00Z --to 2026-06-08T00:00:00Z
#   ./fetch-errors.sh "SI/D/622" --dry-run                         # print query, don't send
#
# .env file (place in same dir as this script):
#   OPENSEARCH_URL=https://...
#   OPENSEARCH_INDEX=channels-olb*
#   OPENSEARCH_COOKIE=session=...     (most common for Dashboards)
#   OPENSEARCH_AUTH=Bearer ...        (alternative auth)
#   OPENSEARCH_XSRF=true
#
# Compatibility: bash 3.2+ (Apple stock /bin/bash).
# Exit codes: 0 ok, 1 bad usage, 2 jq missing, 3 input not readable,
#             4 OpenSearch returned an invalid response.

set -eo pipefail

# Where is this script — needed to locate sibling find-errors.sh
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq required but not on PATH" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl required but not on PATH" >&2
  exit 2
fi

# ----------------------------------------------------------------------------
# Load .env (from current dir, falling back to the script's dir)
# ----------------------------------------------------------------------------
if [ -f .env ]; then
  set -a; . ./.env; set +a
elif [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi

if [ -z "${OPENSEARCH_URL:-}" ]; then
  echo "error: OPENSEARCH_URL not set." >&2
  echo "       Create a .env file (see .env.example) with at minimum OPENSEARCH_URL." >&2
  exit 1
fi

# ----------------------------------------------------------------------------
# Parse args
# ----------------------------------------------------------------------------
if [ "$#" -lt 1 ]; then
  cat >&2 <<USAGE
usage: $0 "CODE1,CODE2,..." [--hours N | --from ISO --to ISO] [--out FILE] [--dry-run]

examples:
  $0 "SI/D/622,SI/D/612"                              # last 24h, count both codes
  $0 "SI/D/" --hours 6                                # last 6h, anything matching SI/D/*
  $0 "SI/D/622" --from 2026-06-07T00:00:00Z --to 2026-06-08T00:00:00Z
  $0 "SI/D/622" --dry-run                             # show query, don't send
USAGE
  exit 1
fi

CODES_ARG="$1"
shift

HOURS=24
FROM=""
TO=""
OUT_JSON=""
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hours)   HOURS="$2";    shift 2 ;;
    --from)    FROM="$2";     shift 2 ;;
    --to)      TO="$2";       shift 2 ;;
    --out)     OUT_JSON="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1;     shift   ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Time range
# ----------------------------------------------------------------------------
# Use python for portable ISO timestamp arithmetic; BSD vs GNU `date` differ.
if [ -z "$FROM" ] || [ -z "$TO" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 required for default time range. Pass --from/--to explicitly." >&2
    exit 2
  fi
  TO=$(python3 -W ignore -c "import datetime as d; print(d.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
  FROM=$(python3 -W ignore -c "import datetime as d; print((d.datetime.utcnow() - d.timedelta(hours=$HOURS)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
fi

INDEX="${OPENSEARCH_INDEX:-channels-olb*}"

# Default output filename if not specified — use first code (slashes → dashes)
if [ -z "$OUT_JSON" ]; then
  SAFE_CODE=$(printf '%s' "$CODES_ARG" | tr ',/' '_-' | tr -cd '[:alnum:]_-' | cut -c1-40)
  OUT_JSON="logs-${SAFE_CODE}-$(date +%Y%m%d-%H%M%S).json"
fi

# ----------------------------------------------------------------------------
# Build the OpenSearch query body.
# Each code becomes a match_phrase filter, OR'd in a `should` clause.
# ----------------------------------------------------------------------------
SHOULD=$(
  printf '%s' "$CODES_ARG" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | grep -v '^$' \
    | jq -R . \
    | jq -s 'map({match_phrase: {message: .}})'
)

BODY=$(jq -n \
  --argjson should "$SHOULD" \
  --arg from "$FROM" \
  --arg to "$TO" \
  --arg index "$INDEX" '
  {
    params: {
      index: $index,
      body: {
        version: true,
        size: 10000,
        sort: [{"@timestamp": {order: "desc", unmapped_type: "boolean"}}],
        _source: true,
        query: {
          bool: {
            must: [],
            filter: [
              { bool: { should: $should, minimum_should_match: 1 } },
              { range: { "@timestamp": { gte: $from, lte: $to,
                  format: "strict_date_optional_time" } } }
            ],
            must_not: [],
            should: []
          }
        }
      }
    }
  }
')

echo "Endpoint:    $OPENSEARCH_URL" >&2
echo "Index:       $INDEX"          >&2
echo "Codes:       $CODES_ARG"      >&2
echo "Time range:  $FROM .. $TO"    >&2
echo "Output JSON: $OUT_JSON"       >&2
echo ""                             >&2

if [ "$DRY_RUN" -eq 1 ]; then
  echo "=== Query body (dry-run) ===" >&2
  printf '%s\n' "$BODY" | jq .
  exit 0
fi

# ----------------------------------------------------------------------------
# Build curl headers from .env
# ----------------------------------------------------------------------------
CURL_ARGS=()
CURL_ARGS+=(-H "Content-Type: application/json")
CURL_ARGS+=(-H "Accept: application/json")

[ -n "${OPENSEARCH_AUTH:-}" ]   && CURL_ARGS+=(-H "Authorization: ${OPENSEARCH_AUTH}")
[ -n "${OPENSEARCH_COOKIE:-}" ] && CURL_ARGS+=(-H "Cookie: ${OPENSEARCH_COOKIE}")
[ -n "${OPENSEARCH_XSRF:-}" ]   && CURL_ARGS+=(-H "osd-xsrf: ${OPENSEARCH_XSRF}")

# Optional extra headers (semicolon-separated)
if [ -n "${OPENSEARCH_EXTRA_HEADERS:-}" ]; then
  OLDIFS="$IFS"
  IFS=';'
  for h in $OPENSEARCH_EXTRA_HEADERS; do
    # trim
    h=$(printf '%s' "$h" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$h" ] && CURL_ARGS+=(-H "$h")
  done
  IFS="$OLDIFS"
fi

# ----------------------------------------------------------------------------
# Fetch
# ----------------------------------------------------------------------------
echo "Fetching ..." >&2
HTTP_STATUS=$(curl -sS -w "%{http_code}" -o "$OUT_JSON" -X POST \
  "${CURL_ARGS[@]}" \
  --data-binary "$BODY" \
  "$OPENSEARCH_URL") || {
    echo "error: curl failed" >&2
    exit 4
  }

if [ "$HTTP_STATUS" != "200" ]; then
  echo "error: HTTP $HTTP_STATUS from OpenSearch" >&2
  echo "response (first 800 chars):" >&2
  head -c 800 "$OUT_JSON" >&2
  echo "" >&2
  exit 4
fi

# Validate it looks like a search response
if ! jq -e '(.rawResponse // .) | has("hits")' "$OUT_JSON" >/dev/null 2>&1; then
  echo "error: response doesn't look like an OpenSearch search result" >&2
  echo "response (first 800 chars):" >&2
  head -c 800 "$OUT_JSON" >&2
  echo "" >&2
  exit 4
fi

# Total available vs returned
HITS_TOTAL=$(jq '(.rawResponse // .).hits.total | if type == "object" then .value else . end' "$OUT_JSON")
HITS_RETURNED=$(jq '[(.rawResponse // .).hits.hits[]?] | length' "$OUT_JSON")

echo "Total in cluster: $HITS_TOTAL" >&2
echo "Returned:         $HITS_RETURNED" >&2
if [ "$HITS_RETURNED" -ge 10000 ] && [ "$HITS_TOTAL" -gt 10000 ]; then
  echo "" >&2
  echo "WARNING: hit the 10k result cap. $((HITS_TOTAL - HITS_RETURNED)) more logs in the cluster" >&2
  echo "         that weren't returned. Narrow --from / --to or specific codes to fit under 10k." >&2
fi
echo "" >&2

# ----------------------------------------------------------------------------
# Hand off to find-errors.sh for the count + CSV
# ----------------------------------------------------------------------------
COUNTER="$SCRIPT_DIR/find-errors.sh"
if [ ! -x "$COUNTER" ]; then
  echo "warning: find-errors.sh not found next to fetch-errors.sh — skipping count." >&2
  echo "saved JSON to: $OUT_JSON" >&2
  exit 0
fi

CSV_OUT="${OUT_JSON%.json}.csv"
"$COUNTER" "$OUT_JSON" "$CODES_ARG" "$CSV_OUT"