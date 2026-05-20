#!/usr/bin/env bash
# map-banking-services-endpoints.sh
# Two-phase Dynatrace probe:
#   1. Discover every /banking/services/* endpoint seen in the last 24h
#      and its most recent trace ID.
#   2. For each endpoint's latest trace, find what downstream calls CDBBOS
#      makes (server.address + endpoint.name + url.path).
# Output: CSV with one row per (entry endpoint, downstream call) pair.
#
# Usage:
#   ./map-banking-services-endpoints.sh [output-file]
#   (no input file: discovery is in Phase 1)
#
# Env (sourced from ./.env if present, else from environment):
#   DYNATRACE_API_URL      e.g. https://<proxy>--<tenant>.prod2.apps.dynatrace.com/platform/storage/query/v1
#   DYNATRACE_TOKEN        platform bearer token
#   DYNATRACE_TENANT_URL   e.g. https://<tenant>.apps.dynatrace.com  (not used here, kept for env parity)
#   SLEEP_BETWEEN_URLS     seconds to sleep between Phase 2 per-trace queries (default 1)
#   PHASE2                 set to 0 to skip Phase 2 (downstream lookup); CSV will only have endpoints + trace IDs
#   MAX_RESULTS            cap Phase 1 row count (default 1000). Useful for fine-tuning: MAX_RESULTS=10
#   DEBUG                  set to 1 to print HTTP body/response on execute failures
#   DEBUG_TRACE            set to 1 to dump raw Phase 2 response when 0 downstream calls found

set -u

# ---------- config ----------
POLL_MAX_ATTEMPTS=30
POLL_SLEEP_SECONDS=1
LINK_WINDOW_SECONDS=45
# Delay between processing each URL. Helps avoid Dynatrace rate-limit / scan-budget
# contention when the input file has many URLs. Override via env: SLEEP_BETWEEN_URLS=0
SLEEP_BETWEEN_URLS="${SLEEP_BETWEEN_URLS:-1}"

# ---------- arg parsing ----------
OUTPUT_FILE="${1:-banking-services-map.csv}"

# ---------- env ----------
if [ -f ".env" ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

: "${DYNATRACE_API_URL:?ERROR: DYNATRACE_API_URL is not set}"
: "${DYNATRACE_TOKEN:?ERROR: DYNATRACE_TOKEN is not set}"

# Strip trailing slash for clean concatenation
DYNATRACE_API_URL="${DYNATRACE_API_URL%/}"

# ---------- helpers ----------

# Build the Phase 1 DQL: discover every /banking/services/* endpoint and its latest trace.
# Groups by Dynatrace's normalized endpoint.name (which strips IDs/UUIDs); falls back
# to url.path when endpoint.name is null. The "CDB - " label prefix Dynatrace sometimes
# adds to endpoint.name is stripped so labelled and unlabelled variants collapse to one row.
# Returns endpoint, latestTraceId, and latestTraceStartTime (used to narrow Phase 2 window).
build_discovery_dql() {
  local limit="${MAX_RESULTS:-1000}"
  printf 'fetch spans, from:-24h, scanLimitGBytes:500 | filter contains(lower(url.path), lower("/banking/services/")) | filter span.kind == "server" | fieldsAdd endpoint = if(isNotNull(endpoint.name), endpoint.name, else: url.path) | fieldsAdd endpoint = replaceString(endpoint, "CDB - ", "") | sort start_time desc | summarize { latestTraceId = takeFirst(trace.id), latestTraceStartTime = takeFirst(start_time) }, by: { endpoint } | limit %s' "$limit"
}

# Compute ISO8601 timestamp offset by N seconds (positive or negative) from a given ISO8601.
# Falls back to the original timestamp if `date` cannot parse it. Used to build a tight
# Phase 2 timeframe window around the trace's start_time.
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

# Build the Phase 2 DQL: for a given trace ID + start time, find CDBBOS''s outbound spans.
# Timeframe is narrowed to ±5 minutes around the trace start_time to keep scan cheap.
# Falls back to last-24h if start_time conversion fails.
build_trace_dql() {
  local trace_id="$1"
  local start_iso="$2"
  local from_iso to_iso timeframe

  if [ -n "$start_iso" ]; then
    from_iso=$(offset_iso "$start_iso" -300)
    to_iso=$(offset_iso "$start_iso" 300)
    if [ "$from_iso" != "$start_iso" ] && [ "$to_iso" != "$start_iso" ]; then
      timeframe="from:\"$from_iso\", to:\"$to_iso\""
    else
      timeframe="from:-24h"
    fi
  else
    timeframe="from:-24h"
  fi

  printf 'fetch spans, %s, scanLimitGBytes:50 | filter trace.id == toUid("%s") | filter isNotNull(server.address) | fieldsAdd serviceName = entityAttr(dt.entity.service, "entity.name") | filter contains(serviceName, "CDBBOS") | fields downstreamHost = server.address, downstreamEndpoint = endpoint.name, downstreamPath = url.path | dedup { downstreamHost, downstreamEndpoint } | limit 50' "$timeframe" "$trace_id"
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

# Extract (endpoint, latestTraceId, latestTraceStartTime) triples from a Phase 1 response.
# Output: one "<endpoint>|<traceId>|<startTime>" per line.
# Splits records on the JSON delimiter "},{" rather than "{" alone so endpoint
# names containing literal "{" (e.g. "/foo/{id}/bar") aren't fragmented.
extract_endpoints() {
  local response="$1"
  printf '%s' "$response" \
    | sed 's/},{/}\n{/g' \
    | grep '"endpoint"' \
    | while IFS= read -r frag; do
        local ep tid sts
        ep=$(printf '%s' "$frag" | grep -oE '"endpoint"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')
        tid=$(printf '%s' "$frag" | grep -oE '"latestTraceId"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
        sts=$(printf '%s' "$frag" | grep -oE '"latestTraceStartTime"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
        if [ -n "$ep" ] && [ -n "$tid" ]; then
          printf '%s|%s|%s\n' "$ep" "$tid" "$sts"
        fi
      done \
    | awk -F'|' '!seen[$1]++'
}

# Extract downstream call rows from a Phase 2 (per-trace) poll response.
# Output: one "<downstreamHost>|<downstreamEndpoint>|<downstreamPath>" per line.
extract_downstream_calls() {
  local response="$1"
  printf '%s' "$response" \
    | sed 's/},{/}\n{/g' \
    | grep '"downstreamHost"' \
    | while IFS= read -r frag; do
        local host ep path
        host=$(printf '%s' "$frag" | grep -oE '"downstreamHost"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')
        ep=$(printf '%s'   "$frag" | grep -oE '"downstreamEndpoint"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')
        path=$(printf '%s' "$frag" | grep -oE '"downstreamPath"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')
        printf '%s|%s|%s\n' "$host" "$ep" "$path"
      done
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

PHASE2="${PHASE2:-1}"

# Write CSV header (overwrites any existing output file).
# Header columns depend on whether Phase 2 is enabled.
if [ "$PHASE2" = "0" ]; then
  echo "entryEndpoint,traceId" > "$OUTPUT_FILE"
else
  echo "entryEndpoint,traceId,downstreamHost,downstreamEndpoint,downstreamPath" > "$OUTPUT_FILE"
fi

# ---- Phase 1: discover endpoints ----
echo "Phase 1: discovering /banking/services/* endpoints (last 24h)..." >&2

discovery_dql=$(build_discovery_dql)
discovery_body=$(build_execute_body "$discovery_dql")

discovery_token=$(execute_query "$discovery_body")
if [ -z "$discovery_token" ]; then
  echo "ERROR: discovery query execute failed. Run with DEBUG=1 for details." >&2
  exit 1
fi

discovery_response=$(poll_query "$discovery_token")
poll_rc=$?
if [ "$poll_rc" -ne 0 ]; then
  echo "ERROR: discovery query poll timed out." >&2
  exit 1
fi

endpoint_pairs=$(extract_endpoints "$discovery_response")
if [ -z "$endpoint_pairs" ]; then
  echo "No endpoints matched /banking/services/* in the last 24h." >&2
  echo "Done. Output: $OUTPUT_FILE" >&2
  exit 0
fi

total=$(printf '%s\n' "$endpoint_pairs" | wc -l | tr -d '[:space:]')
echo "Phase 1: found $total distinct endpoints." >&2

# If Phase 2 is disabled, write the slim CSV (endpoint, traceId) and stop.
if [ "$PHASE2" = "0" ]; then
  echo "Phase 2 disabled (PHASE2=0). Writing endpoints only." >&2
  printf '%s\n' "$endpoint_pairs" | while IFS='|' read -r url_path trace_id _start_time; do
    [ -z "$url_path" ] && continue
    printf '%s,%s\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" >> "$OUTPUT_FILE"
  done
  echo "Done. Output: $OUTPUT_FILE" >&2
  exit 0
fi

# ---- Phase 2: per-trace downstream lookup ----
echo "Phase 2: fetching downstream CDBBOS calls for each endpoint's latest trace..." >&2

index=0
while IFS='|' read -r url_path trace_id start_time; do
  [ -z "$url_path" ] && continue
  index=$(( index + 1 ))

  trace_dql=$(build_trace_dql "$trace_id" "$start_time")
  trace_body=$(build_execute_body "$trace_dql")

  trace_token=$(execute_query "$trace_body")
  if [ -z "$trace_token" ]; then
    echo "[$index/$total] $url_path ($trace_id) ... EXECUTE FAILED" >&2
    printf '%s,%s,%s,,\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" \
      "$(csv_escape "(execute failed)")" >> "$OUTPUT_FILE"
    continue
  fi

  trace_response=$(poll_query "$trace_token")
  poll_rc=$?
  if [ "$poll_rc" -ne 0 ]; then
    echo "[$index/$total] $url_path ($trace_id) ... POLL TIMEOUT" >&2
    printf '%s,%s,%s,,\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" \
      "$(csv_escape "(poll timeout)")" >> "$OUTPUT_FILE"
    continue
  fi

  downstream=$(extract_downstream_calls "$trace_response")
  if [ -z "$downstream" ]; then
    echo "[$index/$total] $url_path ($trace_id) ... 0 downstream calls" >&2
    if [ "${DEBUG_TRACE:-0}" = "1" ]; then
      echo "---- DEBUG_TRACE: raw response for $trace_id ----" >&2
      echo "$trace_response" >&2
      echo "----" >&2
    fi
    printf '%s,%s,%s,,\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" \
      "$(csv_escape "(no downstream calls found)")" >> "$OUTPUT_FILE"
  else
    count=$(printf '%s\n' "$downstream" | wc -l | tr -d '[:space:]')
    echo "[$index/$total] $url_path ($trace_id) ... $count downstream calls" >&2
    printf '%s\n' "$downstream" | while IFS='|' read -r d_host d_ep d_path; do
      printf '%s,%s,%s,%s,%s\n' \
        "$(csv_escape "$url_path")" \
        "$(csv_escape "$trace_id")" \
        "$(csv_escape "$d_host")" \
        "$(csv_escape "$d_ep")" \
        "$(csv_escape "$d_path")" >> "$OUTPUT_FILE"
    done
  fi

  # Delay between per-trace queries, unless this was the last one
  if [ "$index" -lt "$total" ] && [ "$SLEEP_BETWEEN_URLS" != "0" ]; then
    sleep "$SLEEP_BETWEEN_URLS"
  fi

done <<EOF
$endpoint_pairs
EOF

echo "Done. Output: $OUTPUT_FILE" >&2