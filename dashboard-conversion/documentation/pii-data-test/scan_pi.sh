#!/usr/bin/env bash
#
# scan-pii.sh — Scan an OpenSearch JSON response for log messages containing PI data.
#
# Usage:
#   ./scan-pii.sh <opensearch-response.json>          # JSONL to stdout
#   ./scan-pii.sh <opensearch-response.json> report   # human-readable to stdout
#
# Output (JSONL mode), one object per matching log:
#   { "path": "...", "class": "...", "matches": ["SIN","EMAIL"], "message": "..." }
#
# Detected categories:
#   SIN         Canadian Social Insurance Number (9 digits, optional separators)
#   CREDIT_CARD 13-19 digit PAN, Luhn-validated to reduce false positives
#   EMAIL       RFC-ish email address
#   PHONE_NA    North American 10-digit phone number
#   ACCOUNT_NUM 10-17 digit bare numeric runs near "account" / "acct" keywords
#   DOB         Date in YYYY-MM-DD or DD/MM/YYYY form near "dob"/"birth" keyword
#
# Exit codes: 0 ok, 1 bad usage, 2 jq missing, 3 input not readable.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required but not on PATH" >&2
  exit 2
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <opensearch-response.json> [report]" >&2
  exit 1
fi

INPUT="$1"
MODE="${2:-jsonl}"

if [[ ! -r "$INPUT" ]]; then
  echo "error: cannot read $INPUT" >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# Stage 1: pull (path, class, message) tuples out of the OpenSearch response.
# The response can be the full Kibana wrapper ({rawResponse:{hits:...}}) or
# a bare OpenSearch response ({hits:{hits:[...]}}). Handle both.
# Class is parsed from the message: the FQCN token (com.* / ca.* etc.) that
# appears after the log level. If no FQCN is found, class is "".
# ---------------------------------------------------------------------------
EXTRACTED=$(jq -c '
  def extract_class:
    [ scan("\\s(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|SEVERE)\\s+([a-zA-Z_][\\w]*(?:\\.[a-zA-Z_][\\w]*)+)") ]
    | if length == 0 then ""
      else .[0] | if type == "array" then .[0] else . end
      end;
  ( .rawResponse // . ) as $r
  | $r.hits.hits[]
  | {
      path:    (._source.log.file.path // ""),
      message: (._source.message // ""),
      class:   ((._source.message // "") | extract_class)
    }
' "$INPUT")

# ---------------------------------------------------------------------------
# Stage 2: PI detection in pure bash regex. We do this outside jq because
# Luhn validation for credit cards is awkward in jq, and bash regex with
# a small helper function keeps it readable.
# ---------------------------------------------------------------------------

# Luhn check — returns 0 if the digit string passes, 1 otherwise.
luhn_ok() {
  local digits="$1"
  local len=${#digits}
  (( len < 13 || len > 19 )) && return 1
  local sum=0 i parity d doubled
  parity=$(( len % 2 ))
  for (( i=0; i<len; i++ )); do
    d=${digits:i:1}
    if (( i % 2 == parity )); then
      doubled=$(( d * 2 ))
      (( doubled > 9 )) && doubled=$(( doubled - 9 ))
      sum=$(( sum + doubled ))
    else
      sum=$(( sum + d ))
    fi
  done
  (( sum % 10 == 0 ))
}

# Classify a single message; echoes a space-separated list of category labels.
classify() {
  local msg="$1"
  local hits=()
  local lower
  lower=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')

  # SIN: 9 digits, optional space or dash separators, with word boundaries.
  if [[ "$msg" =~ (^|[^0-9])([0-9]{3}[- ]?[0-9]{3}[- ]?[0-9]{3})([^0-9]|$) ]]; then
    # Strip separators and reject obvious garbage (all zeros, all same digit).
    local sin_raw="${BASH_REMATCH[2]//[- ]/}"
    if [[ "$sin_raw" =~ ^[0-9]{9}$ ]] && [[ ! "$sin_raw" =~ ^(.)\1{8}$ ]] && [[ "$sin_raw" != "000000000" ]]; then
      hits+=("SIN")
    fi
  fi

  # Credit card: scan every 13-19 digit run (separators stripped) and Luhn-check.
  local stripped
  stripped=$(printf '%s' "$msg" | sed -E 's/[^0-9]+/ /g')
  local tok
  for tok in $stripped; do
    local len=${#tok}
    if (( len >= 13 && len <= 19 )) && luhn_ok "$tok"; then
      hits+=("CREDIT_CARD")
      break
    fi
  done

  # Email.
  if [[ "$msg" =~ [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,} ]]; then
    hits+=("EMAIL")
  fi

  # North American phone: (xxx) xxx-xxxx or xxx-xxx-xxxx or xxx.xxx.xxxx.
  if [[ "$msg" =~ (^|[^0-9])(\(?[2-9][0-9]{2}\)?[-. ][0-9]{3}[-. ][0-9]{4})($|[^0-9]) ]]; then
    hits+=("PHONE_NA")
  fi

  # Account-ish: a 10-17 digit run near the word account / acct.
  if [[ "$lower" =~ (account|acct)[^0-9]{0,20}[0-9]{10,17} ]]; then
    hits+=("ACCOUNT_NUM")
  fi

  # DOB: keyword near a date.
  if [[ "$lower" =~ (dob|date.of.birth|birth.date|birthdate) ]] && \
     [[ "$msg" =~ (19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]) ||
        "$msg" =~ (0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])/(19|20)[0-9]{2} ]]; then
    hits+=("DOB")
  fi

  printf '%s\n' "${hits[*]}"
}

# ---------------------------------------------------------------------------
# Stage 3: iterate the extracted tuples, classify, emit.
# ---------------------------------------------------------------------------
total=0
flagged=0

while IFS= read -r row; do
  (( ++total ))
  msg=$(jq -r '.message' <<<"$row")
  matches=$(classify "$msg")
  if [[ -n "$matches" ]]; then
    (( ++flagged ))
    if [[ "$MODE" == "report" ]]; then
      path=$(jq -r '.path' <<<"$row")
      class=$(jq -r '.class' <<<"$row")
      printf -- '----\nMATCHES : %s\nPATH    : %s\nCLASS   : %s\nMESSAGE : %s\n' \
        "$matches" "$path" "$class" "$msg"
    else
      # Build a clean JSON object with the matches array merged in.
      jq -c --arg m "$matches" \
        '. + { matches: ($m | split(" ")) } | { path, class, matches, message }' \
        <<<"$row"
    fi
  fi
done <<<"$EXTRACTED"

echo "scanned=$total flagged=$flagged" >&2