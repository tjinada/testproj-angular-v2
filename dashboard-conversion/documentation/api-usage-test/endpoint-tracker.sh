#!/usr/bin/env bash
# map-banking-services-endpoints.sh
# Two-phase Dynatrace probe:
#   1. Discover every /banking/services/* endpoint (or look up a user-provided list)
#      and its most recent trace ID.
#   2. For each endpoint's latest trace, find what downstream calls CDBBOS
#      makes (server.address + endpoint.name + url.path).
# Output: CSV with one row per (entry endpoint, downstream call) pair.
#
# Usage:
#   ./map-banking-services-endpoints.sh [output-file]
#   ./map-banking-services-endpoints.sh -i <input-file> [output-file]
#
# Discovery mode (no -i): Phase 1 queries Dynatrace for all /banking/services/*
# endpoints seen in the last 24h.
#
# Input-list mode (-i <file>): reads one URL per line from <file> and looks up
# each one's most recent trace via exact url.path match. URLs without recent
# traffic appear in the CSV with "(no recent trace found)". Lines starting with
# # are ignored. Optional leading HTTP verb (GET/POST/...) is stripped.
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
# Usage:
#   ./map-banking-services-endpoints.sh [output.csv]                      # discovery mode
#   ./map-banking-services-endpoints.sh -i input.txt [output.csv]         # input-list mode
INPUT_FILE=""
OUTPUT_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -i)
      INPUT_FILE="${2:-}"
      if [ -z "$INPUT_FILE" ]; then
        echo "ERROR: -i requires an input file path" >&2
        exit 1
      fi
      shift 2
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [ -z "$OUTPUT_FILE" ]; then
        OUTPUT_FILE="$1"
      else
        echo "ERROR: unexpected argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done
OUTPUT_FILE="${OUTPUT_FILE:-banking-services-map.csv}"

if [ -n "$INPUT_FILE" ] && [ ! -f "$INPUT_FILE" ]; then
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

# Build the lookup DQL for input-list mode: find the latest trace ID + start_time
# for a single URL using exact url.path match. Returns one row max.
build_lookup_dql() {
  local url="$1"
  printf 'fetch spans, from:-24h, scanLimitGBytes:500 | filter url.path == "%s" | filter span.kind == "server" | sort start_time desc | fields trace.id, start_time | limit 1' "$url"
}

# Extract (traceId, startTime) from a single-row lookup poll response.
# Output: "<traceId>|<startTime>" or empty if no record.
extract_lookup_result() {
  local response="$1"
  local frag
  frag=$(printf '%s' "$response" | sed 's/},{/}\n{/g' | grep '"trace.id"' | head -n1)
  [ -z "$frag" ] && return
  local tid sts sts_num
  tid=$(printf '%s' "$frag" | grep -oE '"trace\.id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
  sts=$(printf '%s' "$frag" | grep -oE '"start_time"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
  if [ -z "$sts" ]; then
    sts_num=$(printf '%s' "$frag" | grep -oE '"start_time"[[:space:]]*:[[:space:]]*[0-9]+' | head -n1 | grep -oE '[0-9]+$')
    if [ -n "$sts_num" ]; then
      sts=$(epoch_ns_to_iso "$sts_num")
    fi
  fi
  if [ -n "$tid" ]; then
    printf '%s|%s\n' "$tid" "$sts"
  fi
}

# Convert nanoseconds-since-epoch (how Dynatrace stores span timestamps) to ISO8601.
# Returns empty string on failure.
epoch_ns_to_iso() {
  local ns="$1"
  local sec="${ns:0:${#ns}-9}"
  [ -z "$sec" ] && return
  local result
  # GNU date
  if result=$(date -u -d "@$sec" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    printf '%s' "$result"
    return
  fi
  # BSD date (macOS)
  if result=$(date -u -r "$sec" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    printf '%s' "$result"
    return
  fi
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
# Filter approach: spans where servlet.context.name == "CDBBOS" AND span.kind == "client"
# are exactly the outbound HTTP calls CDBBOS makes. servlet.context.name stays with the
# calling process even on client spans (unlike service.name which reflects the callee).
# Timeframe is narrowed to ±5 minutes around the trace start_time to keep scan cheap.
# Falls back to last-24h if start_time conversion fails.
build_trace_dql() {
  local trace_id="$1"
  local start_iso="$2"
  local from_iso to_iso timeframe scan_limit

  if [ -n "$start_iso" ]; then
    from_iso=$(offset_iso "$start_iso" -300)
    to_iso=$(offset_iso "$start_iso" 300)
    if [ "$from_iso" != "$start_iso" ] && [ "$to_iso" != "$start_iso" ]; then
      timeframe="from:\"$from_iso\", to:\"$to_iso\""
      scan_limit="50"
    else
      timeframe="from:-24h"
      scan_limit="500"
    fi
  else
    timeframe="from:-24h"
    scan_limit="500"
  fi

  printf 'fetch spans, %s, scanLimitGBytes:%s | filter trace.id == toUid("%s") | filter span.kind == "client" | filter servlet.context.name == "CDBBOS" | fields downstreamHost = server.address, downstreamEndpoint = endpoint.name, downstreamPath = url.path | dedup { downstreamHost, downstreamEndpoint } | limit 50' "$timeframe" "$scan_limit" "$trace_id"
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
        # Try quoted ISO timestamp first
        sts=$(printf '%s' "$frag" | grep -oE '"latestTraceStartTime"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')
        # Fall back to numeric (nanoseconds since epoch); convert to ISO
        if [ -z "$sts" ]; then
          local sts_num
          sts_num=$(printf '%s' "$frag" | grep -oE '"latestTraceStartTime"[[:space:]]*:[[:space:]]*[0-9]+' | head -n1 | grep -oE '[0-9]+$')
          if [ -n "$sts_num" ]; then
            sts=$(epoch_ns_to_iso "$sts_num")
          fi
        fi
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
  echo "entryEndpoint,traceId,downstream" > "$OUTPUT_FILE"
fi

# ---- Phase 1: build (endpoint, traceId, startTime) triples ----
endpoint_pairs=""

if [ -n "$INPUT_FILE" ]; then
  # Input-list mode: look up each URL individually via exact url.path match.
  echo "Phase 1: looking up trace IDs for URLs in $INPUT_FILE (last 24h)..." >&2
  input_count=$(grep -cvE '^[[:space:]]*(#|$)' "$INPUT_FILE" || true)
  input_idx=0
  endpoint_pairs_lines=""

  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    # Trim leading/trailing whitespace
    url="${raw_line#"${raw_line%%[![:space:]]*}"}"
    url="${url%"${url##*[![:space:]]}"}"
    # Skip blanks and comments
    [ -z "$url" ] && continue
    case "$url" in \#*) continue ;; esac
    # Strip leading HTTP verb if present
    case "$url" in
      GET\ *|POST\ *|PUT\ *|DELETE\ *|PATCH\ *|HEAD\ *|OPTIONS\ *)
        url="${url#* }"
        ;;
    esac
    [ -z "$url" ] && continue

    input_idx=$(( input_idx + 1 ))

    lookup_dql=$(build_lookup_dql "$url")
    lookup_body=$(build_execute_body "$lookup_dql")
    lookup_token=$(execute_query "$lookup_body")
    if [ -z "$lookup_token" ]; then
      echo "[$input_idx/$input_count] $url ... LOOKUP EXECUTE FAILED" >&2
      endpoint_pairs_lines="${endpoint_pairs_lines}${url}|LOOKUP_FAILED|
"
      [ "$input_idx" -lt "$input_count" ] && [ "$SLEEP_BETWEEN_URLS" != "0" ] && sleep "$SLEEP_BETWEEN_URLS"
      continue
    fi
    lookup_response=$(poll_query "$lookup_token")
    lookup_rc=$?
    if [ "$lookup_rc" -ne 0 ]; then
      echo "[$input_idx/$input_count] $url ... LOOKUP POLL TIMEOUT" >&2
      endpoint_pairs_lines="${endpoint_pairs_lines}${url}|LOOKUP_TIMEOUT|
"
      [ "$input_idx" -lt "$input_count" ] && [ "$SLEEP_BETWEEN_URLS" != "0" ] && sleep "$SLEEP_BETWEEN_URLS"
      continue
    fi

    pair=$(extract_lookup_result "$lookup_response")
    if [ -z "$pair" ]; then
      echo "[$input_idx/$input_count] $url ... no recent trace" >&2
      endpoint_pairs_lines="${endpoint_pairs_lines}${url}|NO_TRACE|
"
    else
      echo "[$input_idx/$input_count] $url ... found trace ${pair%%|*}" >&2
      endpoint_pairs_lines="${endpoint_pairs_lines}${url}|${pair}
"
    fi

    [ "$input_idx" -lt "$input_count" ] && [ "$SLEEP_BETWEEN_URLS" != "0" ] && sleep "$SLEEP_BETWEEN_URLS"
  done < "$INPUT_FILE"

  endpoint_pairs=$(printf '%s' "$endpoint_pairs_lines" | sed '/^$/d')
else
  # Discovery mode: one big query to find every /banking/services/* endpoint.
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
fi

if [ -z "$endpoint_pairs" ]; then
  echo "No endpoints to process." >&2
  echo "Done. Output: $OUTPUT_FILE" >&2
  exit 0
fi

total=$(printf '%s\n' "$endpoint_pairs" | wc -l | tr -d '[:space:]')
echo "Phase 1: $total endpoint(s) ready for Phase 2." >&2

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

  # Handle sentinel values from input-list lookup failures
  case "$trace_id" in
    LOOKUP_FAILED)
      echo "[$index/$total] $url_path ... skipped (lookup failed)" >&2
      printf '%s,,%s\n' \
        "$(csv_escape "$url_path")" \
        "$(csv_escape "(lookup failed)")" >> "$OUTPUT_FILE"
      continue
      ;;
    LOOKUP_TIMEOUT)
      echo "[$index/$total] $url_path ... skipped (lookup timeout)" >&2
      printf '%s,,%s\n' \
        "$(csv_escape "$url_path")" \
        "$(csv_escape "(lookup timeout)")" >> "$OUTPUT_FILE"
      continue
      ;;
    NO_TRACE)
      echo "[$index/$total] $url_path ... skipped (no recent trace)" >&2
      printf '%s,,%s\n' \
        "$(csv_escape "$url_path")" \
        "$(csv_escape "(no recent trace found)")" >> "$OUTPUT_FILE"
      continue
      ;;
  esac

  trace_dql=$(build_trace_dql "$trace_id" "$start_time")
  trace_body=$(build_execute_body "$trace_dql")

  trace_token=$(execute_query "$trace_body")
  if [ -z "$trace_token" ]; then
    echo "[$index/$total] $url_path ($trace_id) ... EXECUTE FAILED" >&2
    printf '%s,%s,%s\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" \
      "$(csv_escape "(execute failed)")" >> "$OUTPUT_FILE"
    continue
  fi

  trace_response=$(poll_query "$trace_token")
  poll_rc=$?
  if [ "$poll_rc" -ne 0 ]; then
    echo "[$index/$total] $url_path ($trace_id) ... POLL TIMEOUT" >&2
    printf '%s,%s,%s\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" \
      "$(csv_escape "(poll timeout)")" >> "$OUTPUT_FILE"
    continue
  fi

  downstream=$(extract_downstream_calls "$trace_response")

  # Drop rows without a downstreamPath (they're filler/noise).
  if [ -n "$downstream" ]; then
    downstream=$(printf '%s\n' "$downstream" | awk -F'|' '$3 != "" { print }')
  fi

  if [ -z "$downstream" ]; then
    echo "[$index/$total] $url_path ($trace_id) ... 0 downstream calls" >&2
    if [ "${DEBUG_TRACE:-0}" = "1" ]; then
      echo "---- DEBUG_TRACE: raw response for $trace_id ----" >&2
      echo "$trace_response" >&2
      echo "----" >&2
    fi
    printf '%s,%s,%s\n' \
      "$(csv_escape "$url_path")" \
      "$(csv_escape "$trace_id")" \
      "$(csv_escape "(no downstream calls found)")" >> "$OUTPUT_FILE"
  else
    count=$(printf '%s\n' "$downstream" | wc -l | tr -d '[:space:]')
    echo "[$index/$total] $url_path ($trace_id) ... $count downstream calls" >&2
    # First row carries entryEndpoint + traceId; subsequent rows leave those blank
    # so multiple downstreams are visually grouped under one entry.
    first_row=1
    printf '%s\n' "$downstream" | while IFS='|' read -r d_host _d_ep d_path; do
      # Combine host + path with a single slash. Strip any leading slash on path
      # to avoid host//path. If host is empty but path isn't, just use path.
      d_path_trimmed="${d_path#/}"
      if [ -n "$d_host" ]; then
        combined="${d_host}/${d_path_trimmed}"
      else
        combined="/${d_path_trimmed}"
      fi
      if [ "$first_row" = "1" ]; then
        printf '%s,%s,%s\n' \
          "$(csv_escape "$url_path")" \
          "$(csv_escape "$trace_id")" \
          "$(csv_escape "$combined")" >> "$OUTPUT_FILE"
        first_row=0
      else
        printf ',,%s\n' "$(csv_escape "$combined")" >> "$OUTPUT_FILE"
      fi
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