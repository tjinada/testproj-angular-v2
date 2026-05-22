#!/usr/bin/env bash
#
# scan-pii.sh — Scan an OpenSearch JSON response for log messages containing PI data.
#
# Usage:
#   ./scan-pii.sh <opensearch-response.json>          # JSONL to stdout
#   ./scan-pii.sh <opensearch-response.json> report   # human-readable to stdout
#   ./scan-pii.sh <opensearch-response.json> csv      # CSV to stdout
#       (redirect to a file: ./scan-pii.sh in.json csv > hits.csv)
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
# Compatibility: works on bash 3.2 (Apple stock /bin/bash) and newer.
# Exit codes: 0 ok, 1 bad usage, 2 jq missing, 3 input not readable.

# NOTE: deliberately not using `set -u` because bash 3.2 trips on empty
# arrays and unset BASH_REMATCH groups even with defensive guards.
set -eo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required but not on PATH" >&2
  exit 2
fi

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <opensearch-response.json> [jsonl|report|csv]" >&2
  exit 1
fi

INPUT="$1"
MODE="${2:-jsonl}"

if [ ! -r "$INPUT" ]; then
  echo "error: cannot read $INPUT" >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# Stage 1: extract (path, message, class) tuples from the OpenSearch response.
# Handles both the Kibana-wrapped shape ({rawResponse:{hits:...}}) and a bare
# OpenSearch response ({hits:{hits:[...]}}).
# Class is the first FQCN-looking token after the log level inside `message`.
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
# Luhn check — returns 0 if the digit string passes, 1 otherwise.
# Pure arithmetic, no arrays, bash 3.2 safe.
# ---------------------------------------------------------------------------
luhn_ok() {
  local digits="$1"
  local len=${#digits}
  if [ "$len" -lt 13 ] || [ "$len" -gt 19 ]; then
    return 1
  fi
  local sum=0 i parity d doubled
  parity=$(( len % 2 ))
  i=0
  while [ "$i" -lt "$len" ]; do
    d=${digits:$i:1}
    if [ $(( i % 2 )) -eq "$parity" ]; then
      doubled=$(( d * 2 ))
      [ "$doubled" -gt 9 ] && doubled=$(( doubled - 9 ))
      sum=$(( sum + doubled ))
    else
      sum=$(( sum + d ))
    fi
    i=$(( i + 1 ))
  done
  [ $(( sum % 10 )) -eq 0 ]
}

# ---------------------------------------------------------------------------
# Classify one message; prints a space-separated list of category labels,
# or an empty line if nothing matched.
# ---------------------------------------------------------------------------
classify() {
  local msg="$1"
  local out=""
  local lower
  lower=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')

  # --- SIN: 9 digits with optional dash/space separators, with word boundaries.
  if [[ "$msg" =~ (^|[^0-9])([0-9]{3}[-\ ]?[0-9]{3}[-\ ]?[0-9]{3})([^0-9]|$) ]]; then
    local sin_raw="${BASH_REMATCH[2]}"
    # strip separators
    sin_raw=$(printf '%s' "$sin_raw" | tr -d -- '- ')
    # reject obvious garbage (all zeros / all same digit)
    if [ "${#sin_raw}" -eq 9 ] \
       && [ "$sin_raw" != "000000000" ] \
       && ! [[ "$sin_raw" =~ ^(.)\1{8}$ ]]; then
      out="$out SIN"
    fi
  fi

  # --- Credit card: any 13-19 digit run (separators stripped) that passes Luhn.
  local stripped
  stripped=$(printf '%s' "$msg" | sed -E 's/[^0-9]+/ /g')
  local tok
  for tok in $stripped; do
    local tlen=${#tok}
    if [ "$tlen" -ge 13 ] && [ "$tlen" -le 19 ] && luhn_ok "$tok"; then
      out="$out CREDIT_CARD"
      break
    fi
  done

  # --- Email.
  if [[ "$msg" =~ [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,} ]]; then
    out="$out EMAIL"
  fi

  # --- North American phone: (xxx) xxx-xxxx, xxx-xxx-xxxx, xxx.xxx.xxxx, etc.
  if [[ "$msg" =~ (^|[^0-9])(\(?[2-9][0-9]{2}\)?[-.\ ][0-9]{3}[-.\ ][0-9]{4})($|[^0-9]) ]]; then
    out="$out PHONE_NA"
  fi

  # --- Account-like: 10-17 digit run within ~20 chars of "account"/"acct".
  if [[ "$lower" =~ (account|acct)[^0-9]{0,20}[0-9]{10,17} ]]; then
    out="$out ACCOUNT_NUM"
  fi

  # --- DOB: keyword near a date.
  if [[ "$lower" =~ (dob|date.of.birth|birth.date|birthdate) ]]; then
    if [[ "$msg" =~ (19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]) ]] \
       || [[ "$msg" =~ (0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])/(19|20)[0-9]{2} ]]; then
      out="$out DOB"
    fi
  fi

  # Trim and print
  out="${out# }"
  printf '%s\n' "$out"
}

# ---------------------------------------------------------------------------
# Stage 3: iterate and emit.
# ---------------------------------------------------------------------------
total=0
flagged=0

while IFS= read -r row; do
  [ -z "$row" ] && continue
  total=$(( total + 1 ))
  msg=$(printf '%s' "$row" | jq -r '.message')
  matches=$(classify "$msg")
  if [ -n "$matches" ]; then
    flagged=$(( flagged + 1 ))
    if [ "$MODE" = "report" ]; then
      path=$(printf '%s' "$row" | jq -r '.path')
      class=$(printf '%s' "$row" | jq -r '.class')
      printf -- '----\nMATCHES : %s\nPATH    : %s\nCLASS   : %s\nMESSAGE : %s\n' \
        "$matches" "$path" "$class" "$msg"
    elif [ "$MODE" = "csv" ]; then
      # Emit a header on the first flagged row.
      if [ "$flagged" -eq 1 ]; then
        printf '%s\n' '"path","class","matches","message"'
      fi
      # Let jq do the CSV quoting; matches joined with ';' (commas collide).
      # tr strips the carriage return @csv adds, so output is LF-only.
      printf '%s' "$row" \
        | jq -r --arg m "$matches" \
            '[.path, .class, ($m | gsub(" "; ";")), .message] | @csv' \
        | tr -d '\r'
    else
      printf '%s' "$row" \
        | jq -c --arg m "$matches" \
            '. + { matches: ($m | split(" ")) } | { path, class, matches, message }'
    fi
  fi
done <<< "$EXTRACTED"

echo "scanned=$total flagged=$flagged" >&2