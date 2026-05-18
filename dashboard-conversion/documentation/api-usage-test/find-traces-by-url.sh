\#!/usr/bin/env bash
# find-traces-by-url.sh
# Reads URL paths from a text file (one per line) and queries Dynatrace
# for traces where url.path matches exactly. Writes grouped CSV output.
#
# Usage:
#   ./find-traces-by-url.sh <input-file> [output-file]
#
# Env (sourced from ./.env if present, else from environment):
#   DYNATRACE_API_URL      e.g. https://<proxy>--<tenant>.prod2.apps.dynatrace.com/platform/storage/query/v1
#   DYNATRACE_TOKEN        platform bearer token
#   DYNATRACE_TENANT_URL   e.g. https://<tenant>.apps.dynatrace.com  (used for deep-link)

set -u

# ---------- config ----------
POLL_MAX_ATTEMPTS=30
POLL_SLEEP_SECONDS=1
LINK_WINDOW_SECONDS=45
# Delay between processing each URL. Helps avoid Dynatrace rate-limit / scan-budget
# contention when the input file has many URLs. Override via env: SLEEP_BETWEEN_URLS=0
SLEEP_BETWEEN_URLS="${SLEEP_BETWEEN_URLS:-1}"

# ---------- arg parsing ----------
if [ $# -lt 1 ]; then
  echo "Usage: $0 <input-file> [output-file]" >&2
  exit 1
fi

INPUT_FILE="$1"
OUTPUT_FILE="${2:-traces-output.csv}"

if [ ! -f "$INPUT_FILE" ]; then
  echo "ERROR: input file not found: $INPUT_FILE" >&2
  exit 1
fi

# ---------- env ----------
if [ -f ".env" ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

: "${DYNATRACE_API_URL:?ERROR: DYNATRACE_API_URL is not set}"
: "${DYNATRACE_TOKEN:?ERROR: DYNATRACE_TOKEN is not set}"
: "${DYNATRACE_TENANT_URL:?ERROR: DYNATRACE_TENANT_URL is not set}"

# Strip trailing slashes for clean concatenation
DYNATRACE_API_URL="${DYNATRACE_API_URL%/}"
DYNATRACE_TENANT_URL="${DYNATRACE_TENANT_URL%/}"

# ---------- helpers ----------

# Normalize a raw input line into a DQL search pattern.
#   1. Strip a leading HTTP verb + space (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS).
#   2. Truncate at the first '{' to use the longest static prefix.
# Examples:
#   "GET /cdb/foo/admin/alertChangeHistory"             -> "/cdb/foo/admin/alertChangeHistory"
#   "POST /cdb/customer/{OCIFID}/preference/delivery"   -> "/cdb/customer/"
#   "/mcadmin/.../statementTransactions/{ccNumber}"     -> "/mcadmin/.../statementTransactions/"
normalize_url() {
  local s="$1"
  # 1. Strip leading HTTP verb + single space
  case "$s" in
    GET\ *|POST\ *|PUT\ *|DELETE\ *|PATCH\ *|HEAD\ *|OPTIONS\ *)
      s="${s#* }"
      ;;
  esac
  # 2. Truncate at first '{' if present
  case "$s" in
    *\{*) s="${s%%\{*}" ;;
  esac
  printf '%s' "$s"
}

# Build the DQL query for a given URL path.
# Note: the URL is interpolated into a double-quoted DQL string literal; if any
# input URL ever contains a double quote, escape it before reaching here.
build_dql() {
  local url="$1"
  printf 'fetch spans, from:-24h, scanLimitGBytes:500 | filter contains(lower(url.path), lower("%s")) | fieldsAdd _kindRank = if(span.kind == "server", 0, else: 1) | sort _kindRank asc | summarize { startTime = takeMin(start_time) }, by: { trace.id } | sort startTime desc | limit 1' "$url"
}

# Build the JSON body for query:execute.
# We escape backslashes and double quotes in the DQL string so the JSON is valid.
build_execute_body() {
  local dql="$1"
  # Escape backslashes first, then double quotes
  local escaped="${dql//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf '{"query":"%s","defaultTimeframeStart":null,"defaultTimeframeEnd":null}' "$escaped"
}

# Extract the first match of a "key":"value" pair from JSON-ish text via grep/sed.
# Usage: extract_string_field <key> <text>
extract_string_field() {
  local key="$1"
  local text="$2"
  printf '%s' "$text" \
    | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n1 \
    | sed -E 's/^"[^"]+"[[:space:]]*:[[:space:]]*"(.*)"$/\1/'
}

# Compute ISO8601 timestamp offset by N seconds (positive or negative) from a given ISO8601.
# Falls back to the original timestamp if `date` cannot parse it.
offset_iso() {
  local iso="$1"
  local offset_sec="$2"
  local result
  # GNU date
  if result=$(date -u -d "$iso $offset_sec seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    printf '%s' "$result"
    return
  fi
  # BSD date (macOS)
  local sign="+"
  if [ "$offset_sec" -lt 0 ]; then
    sign="-"
    offset_sec=$(( -offset_sec ))
  fi
  if result=$(date -u -j -v"${sign}${offset_sec}S" -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    printf '%s' "$result"
    return
  fi
  printf '%s' "$iso"
}

# URL-encode an ISO8601 timestamp: replace ':' with '%3A'. The 'Z' and '-' and digits are safe.
urlencode_iso() {
  local s="$1"
  printf '%s' "${s//:/%3A}"
}

# Build the Dynatrace trace deep-link using the explorer URL format.
# Format: <tenant>/ui/apps/dynatrace.distributedtracing/explorer?traceId=<id>&tt=<urlencoded-iso8601>
build_link() {
  local trace_id="$1"
  local start_iso="$2"
  local tt
  tt=$(urlencode_iso "$start_iso")
  printf '%s/ui/apps/dynatrace.distributedtracing/explorer?traceId=%s&tt=%s' \
    "$DYNATRACE_TENANT_URL" "$trace_id" "$tt"
}

# Execute query and return the requestToken on stdout. Empty on failure.
# When DEBUG=1, prints HTTP status and response body to stderr on failure.
execute_query() {
  local body="$1"
  local response http_code
  # Write body to stdout, status code to a temp marker on the last line
  response=$(curl -sS -w '\n__HTTP_STATUS__:%{http_code}' -X POST \
    -H "Authorization: Bearer $DYNATRACE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$DYNATRACE_API_URL/query:execute" 2>&1)
  http_code=$(printf '%s' "$response" | grep -oE '__HTTP_STATUS__:[0-9]+' | tail -n1 | cut -d: -f2)
  response=$(printf '%s' "$response" | sed -E 's/__HTTP_STATUS__:[0-9]+$//')

  local token
  token=$(extract_string_field "requestToken" "$response")

  if [ -z "$token" ] && [ "${DEBUG:-0}" = "1" ]; then
    echo "---- DEBUG: execute failed ----" >&2
    echo "URL:    $DYNATRACE_API_URL/query:execute" >&2
    echo "Status: ${http_code:-no-status}" >&2
    echo "Body:   $body" >&2
    echo "Resp:   $response" >&2
    echo "-------------------------------" >&2
  fi

  printf '%s' "$token"
}

# Poll until state != RUNNING (or attempts exhausted). Echoes the final response body.
poll_query() {
  local token="$1"
  local attempt=0
  local response=""
  while [ "$attempt" -lt "$POLL_MAX_ATTEMPTS" ]; do
    response=$(curl -sS -G \
      -H "Authorization: Bearer $DYNATRACE_TOKEN" \
      --data-urlencode "request-token=$token" \
      "$DYNATRACE_API_URL/query:poll" 2>/dev/null)
    if ! printf '%s' "$response" | grep -q '"state"[[:space:]]*:[[:space:]]*"RUNNING"'; then
      printf '%s' "$response"
      return 0
    fi
    sleep "$POLL_SLEEP_SECONDS"
    attempt=$(( attempt + 1 ))
  done
  printf '%s' "$response"
  return 1
}

# Extract (trace.id, start_time) pairs from the poll response.
# Output: one "<traceId>|<startTime>" per line, deduped by traceId (first start_time kept).
extract_trace_pairs() {
  local response="$1"
  # Pull out each record fragment up to (and excluding) the next record.
  # We use the fact that records contain "trace.id":"..." and "start_time":"..."
  # appearing close together. Splitting on '{' gives us per-object fragments.
  printf '%s' "$response" \
    | tr '{' '\n' \
    | grep '"trace.id"' \
    | while IFS= read -r frag; do
        local tid sts
        tid=$(printf '%s' "$frag" | grep -oE '"trace\.id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
        sts=$(printf '%s' "$frag" | grep -oE '"startTime"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
        if [ -n "$tid" ]; then
          printf '%s|%s\n' "$tid" "$sts"
        fi
      done \
    | awk -F'|' '!seen[$1]++'
}

# CSV-escape a field per RFC 4180: wrap in quotes if it contains comma, quote, or newline;
# double any embedded quotes.
csv_escape() {
  local v="$1"
  case "$v" in
    *,*|*\"*|*$'\n'*)
      v="${v//\"/\"\"}"
      printf '"%s"' "$v"
      ;;
    *)
      printf '%s' "$v"
      ;;
  esac
}

# ---------- main ----------

# Count non-blank, non-comment lines for progress
total=$(grep -cvE '^[[:space:]]*(#|$)' "$INPUT_FILE" || true)
index=0

# Write CSV header (overwrites any existing output file)
echo "url,matches,traceId,timestamp,link" > "$OUTPUT_FILE"

while IFS= read -r raw_line || [ -n "$raw_line" ]; do
  # Trim leading/trailing whitespace
  url="${raw_line#"${raw_line%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"

  # Skip blanks and comments
  [ -z "$url" ] && continue
  case "$url" in \#*) continue ;; esac

  index=$(( index + 1 ))

  # Normalize for DQL search (strip HTTP verb, truncate at first '{'),
  # but keep the original $url for display in the CSV.
  search_pattern=$(normalize_url "$url")
  if [ -z "$search_pattern" ]; then
    echo "[$index/$total] $url ... SKIPPED (empty after normalization)" >&2
    printf '%s,%s,,,\n' "$(csv_escape "$url")" "$(csv_escape "invalid input")" >> "$OUTPUT_FILE"
    continue
  fi

  dql=$(build_dql "$search_pattern")
  body=$(build_execute_body "$dql")

  token=$(execute_query "$body")
  if [ -z "$token" ]; then
    echo "[$index/$total] $url ... EXECUTE FAILED" >&2
    printf '%s,%s,,,\n' "$(csv_escape "$url")" "$(csv_escape "execute failed")" >> "$OUTPUT_FILE"
    continue
  fi

  poll_response=$(poll_query "$token")
  poll_rc=$?
  if [ "$poll_rc" -ne 0 ]; then
    echo "[$index/$total] $url ... POLL TIMEOUT" >&2
    printf '%s,%s,,,\n' "$(csv_escape "$url")" "$(csv_escape "poll timeout")" >> "$OUTPUT_FILE"
    continue
  fi

  pairs=$(extract_trace_pairs "$poll_response")
  if [ -z "$pairs" ]; then
    count=0
  else
    count=$(printf '%s\n' "$pairs" | wc -l | tr -d '[:space:]')
  fi

  echo "[$index/$total] $url ... $count matches" >&2

  # One flat row per URL: url, matches, traceId, timestamp, link.
  # Empty trace fields when there are no matches.
  if [ "$count" -gt 0 ]; then
    # Take the first (and only, since limit 1) trace pair
    first_pair=$(printf '%s\n' "$pairs" | head -n1)
    tid="${first_pair%%|*}"
    sts="${first_pair#*|}"
    link=$(build_link "$tid" "$sts")
    printf '%s,%s,%s,%s,%s\n' \
      "$(csv_escape "$url")" \
      "$count" \
      "$(csv_escape "$tid")" \
      "$(csv_escape "$sts")" \
      "$(csv_escape "$link")" >> "$OUTPUT_FILE"
  else
    printf '%s,%s,,,\n' "$(csv_escape "$url")" "0" >> "$OUTPUT_FILE"
  fi

  # Delay before next URL, unless this was the last one
  if [ "$index" -lt "$total" ] && [ "$SLEEP_BETWEEN_URLS" != "0" ]; then
    sleep "$SLEEP_BETWEEN_URLS"
  fi

done < "$INPUT_FILE"

echo "Done. Output: $OUTPUT_FILE" >&2