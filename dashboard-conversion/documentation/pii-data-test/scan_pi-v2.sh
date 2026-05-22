#!/usr/bin/env bash
#
# scan-pii.sh — Scan an OpenSearch JSON response for log messages containing PI data.
#
# Usage:
#   ./scan-pii.sh <opensearch-response.json>                # JSONL to stdout
#   ./scan-pii.sh <opensearch-response.json> report         # human-readable to stdout
#   ./scan-pii.sh <opensearch-response.json> csv            # CSV to stdout
#   ./scan-pii.sh <opensearch-response.json> csv hits.csv   # CSV to hits.csv
#   ./scan-pii.sh <opensearch-response.json> hits.csv       # CSV to hits.csv (auto-detected by .csv)
#
# Output (JSONL mode), one object per matching log:
#   { "path": "...", "class": "...", "matches": ["SIN","EMAIL"], "message": "..." }
#
# Detected categories:
#   SIN         Canadian Social Insurance Number — 9 digits at a strict word
#               boundary, passes Canadian Luhn checksum. Rejects hex tails.
#   CREDIT_CARD 13-19 digit PAN, Luhn-validated AND starting with a real card
#               brand prefix (Visa/MC/Amex/Discover/Diners/JCB). Rejects
#               unix-ms timestamps and other Luhn-coincidence numbers.
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
  echo "usage: $0 <opensearch-response.json> [jsonl|report|csv] [out.csv]" >&2
  exit 1
fi

INPUT="$1"
ARG2="${2:-}"
ARG3="${3:-}"

# Argument shape detection — be lenient so common mistakes Just Work:
#   scan-pii.sh in.json                  -> JSONL to stdout
#   scan-pii.sh in.json report           -> report to stdout
#   scan-pii.sh in.json csv              -> CSV to stdout
#   scan-pii.sh in.json csv out.csv      -> CSV written directly to out.csv
#   scan-pii.sh in.json out.csv          -> CSV written directly to out.csv (auto-detect)
MODE="jsonl"
OUT_FILE=""
case "$ARG2" in
  ""|jsonl)
    MODE="jsonl" ;;
  report)
    MODE="report" ;;
  csv)
    MODE="csv"
    OUT_FILE="$ARG3" ;;
  *.csv|*.CSV)
    # Auto-detect: arg2 looks like a CSV filename.
    MODE="csv"
    OUT_FILE="$ARG2" ;;
  *)
    echo "warning: unrecognized arg '$ARG2' — defaulting to JSONL output." >&2
    echo "         expected: jsonl | report | csv | <filename.csv>" >&2
    MODE="jsonl" ;;
esac

if [ ! -r "$INPUT" ]; then
  echo "error: cannot read $INPUT" >&2
  exit 3
fi

# If we have an output file, route stdout to it and announce the absolute
# path up front so the user knows where to look.
if [ "$MODE" = "csv" ] && [ -n "$OUT_FILE" ]; then
  case "$OUT_FILE" in
    /*) abs_out="$OUT_FILE" ;;
    *)  abs_out="$PWD/$OUT_FILE" ;;
  esac
  echo "writing CSV to: $abs_out" >&2
  exec > "$OUT_FILE"
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
# Works for any length; callers do their own length validation.
# ---------------------------------------------------------------------------
luhn_ok() {
  local digits="$1"
  local len=${#digits}
  [ "$len" -lt 2 ] && return 1
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

  # --- SIN: 9 digits with separators. Strategy:
  #     1. Find any 9-digit candidate at non-digit boundaries.
  #     2. Reject if either boundary char is a hex letter [a-fA-F] — that
  #        almost always means we're embedded in a hex blob like FBC=[c137939848f...].
  #     3. Pass Canadian Luhn checksum (real SINs satisfy this).
  #     4. Reject all-zeros / all-same-digit.
  if [[ "$msg" =~ (^|[^0-9])([0-9]{3}[-\ ]?[0-9]{3}[-\ ]?[0-9]{3})([^0-9]|$) ]]; then
    local before="${BASH_REMATCH[1]}"
    local sin_raw="${BASH_REMATCH[2]}"
    local after="${BASH_REMATCH[3]}"
    sin_raw=$(printf '%s' "$sin_raw" | tr -d -- '- ')
    # Reject hex-context matches.
    if [[ ! "$before" =~ [a-fA-F] ]] \
       && [[ ! "$after" =~ [a-fA-F] ]] \
       && [ "${#sin_raw}" -eq 9 ] \
       && [ "$sin_raw" != "000000000" ] \
       && ! [[ "$sin_raw" =~ ^(.)\1{8}$ ]] \
       && luhn_ok "$sin_raw"; then
      out="$out SIN"
    fi
  fi

  # --- Credit card: 13-19 digit run that:
  #     1. Has neighboring chars that aren't hex letters [a-fA-F] (so we don't
  #        match decimal-only stretches inside a hex blob).
  #     2. Passes Luhn (Luhn alone matches ~10% of random numeric runs).
  #     3. Starts with a real PAN prefix:
  #          4xxx               Visa            (13, 16, 19 digits)
  #          5[1-5]xx           Mastercard      (16)
  #          2[2-7]xx           Mastercard new  (16)
  #          3[47]xx            Amex            (15)
  #          6011 / 65xx        Discover        (16, 19)
  #          3[0689]xx          Diners / JCB    (14-19)
  #        This drops Unix-ms timestamps (1779…, 1682…) since they start with 1.
  # Use awk to scan with position awareness so we can check neighboring chars.
  local cc_found
  cc_found=$(printf '%s' "$msg" | awk '
    {
      n = length($0)
      i = 1
      while (i <= n) {
        # find next digit
        if (substr($0, i, 1) ~ /[0-9]/) {
          j = i
          while (j <= n && substr($0, j, 1) ~ /[0-9]/) j++
          run = substr($0, i, j - i)
          if (length(run) >= 13 && length(run) <= 19) {
            before = (i > 1) ? substr($0, i - 1, 1) : ""
            after  = (j <= n) ? substr($0, j, 1) : ""
            if (before !~ /[a-fA-F]/ && after !~ /[a-fA-F]/) {
              print run
            }
          }
          i = j
        } else {
          i++
        }
      }
    }')
  if [ -n "$cc_found" ]; then
    local cc
    while IFS= read -r cc; do
      [ -z "$cc" ] && continue
      case "$cc" in
        4*|51*|52*|53*|54*|55*|22*|23*|24*|25*|26*|270*|271*|2720*|34*|37*|6011*|65*|644*|645*|646*|647*|648*|649*|300*|301*|302*|303*|304*|305*|36*|38*|39*) ;;
        *) continue ;;
      esac
      if luhn_ok "$cc"; then
        out="$out CREDIT_CARD"
        break
      fi
    done <<< "$cc_found"
  fi

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
  # Keyword must be a bona fide DOB indicator, not a substring inside method
  # names like doBuild, doBegin, doBootstrap, doBatch, etc. (Java frameworks
  # are full of these and a naive `dob` substring match flags every deep
  # stack trace.) Requirements per pattern:
  #   - "dob" must have non-letter boundaries on both sides
  #   - "date of birth" / "birth date" use a literal whitespace/separator
  #     between words (not regex .) so they don't match "datexofxbirth"
  #   - "dateOfBirth" / "birthDate" / "birthdate" caught by the lowercase form
  if [[ "$lower" =~ (^|[^a-z])(dob|dateofbirth|birthdate|date[\ ._-]of[\ ._-]birth|birth[\ ._-]date)([^a-z]|$) ]]; then
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
# Stage 3: iterate and emit, with progress on stderr.
# ---------------------------------------------------------------------------
total=0
flagged=0

# Count rows up front so progress can show N/M.
# Empty grep is fine — EXTRACTED has one row per line.
row_total=$(printf '%s\n' "$EXTRACTED" | grep -c '^.')

# Progress style: in-place \r update if stderr is a terminal, else periodic
# newline-terminated lines (so it stays readable in a piped log).
if [ -t 2 ]; then
  progress_mode="tty"
else
  progress_mode="log"
fi

# How often to emit progress. Tweak if you find it too chatty / not chatty enough.
progress_every=100

emit_progress() {
  if [ "$progress_mode" = "tty" ]; then
    # \r returns to col 0, trailing spaces erase leftover chars from prior line
    printf '\r[progress] %d/%d  flagged=%d        ' \
      "$total" "$row_total" "$flagged" >&2
  else
    printf '[progress] %d/%d flagged=%d\n' \
      "$total" "$row_total" "$flagged" >&2
  fi
}

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
      # First flagged row: emit a UTF-8 BOM so Excel opens the file as UTF-8
      # CSV cleanly on macOS/Windows, then the header.
      if [ "$flagged" -eq 1 ]; then
        printf '\xef\xbb\xbf'
        printf '%s\n' '"path","class","matches","message"'
      fi
      # Flatten any newlines / tabs inside the message to literal '\n' / '\t'
      # so each log stays on exactly one CSV row (avoids Excel splitting on
      # embedded line breaks even though RFC 4180 allows them).
      # jq's gsub does the substitution; @csv handles quote escaping.
      printf '%s' "$row" \
        | jq -r --arg m "$matches" '
            [.path,
             .class,
             ($m | gsub(" "; ";")),
             (.message
                | gsub("\r\n"; "\\n")
                | gsub("\n";   "\\n")
                | gsub("\r";   "\\n")
                | gsub("\t";   "\\t"))
            ] | @csv
          ' \
        | tr -d '\r'
    else
      printf '%s' "$row" \
        | jq -c --arg m "$matches" \
            '. + { matches: ($m | split(" ")) } | { path, class, matches, message }'
    fi
  fi

  if [ $(( total % progress_every )) -eq 0 ]; then
    emit_progress
  fi
done <<< "$EXTRACTED"

# Final progress + newline so the summary line below isn't clobbered.
emit_progress
if [ "$progress_mode" = "tty" ]; then
  printf '\n' >&2
fi

# In CSV mode, if nothing flagged we'd otherwise have an empty file. Write
# at least the BOM + header so the user can tell the script ran.
if [ "$MODE" = "csv" ] && [ "$flagged" -eq 0 ]; then
  printf '\xef\xbb\xbf'
  printf '%s\n' '"path","class","matches","message"'
fi

echo "scanned=$total flagged=$flagged" >&2

# Report the output file location so it's never a mystery where the CSV went.
if [ "$MODE" = "csv" ] && [ -n "$OUT_FILE" ]; then
  # Resolve to absolute path without requiring `realpath` (not on stock macOS).
  case "$OUT_FILE" in
    /*) abs_out="$OUT_FILE" ;;
    *)  abs_out="$PWD/$OUT_FILE" ;;
  esac
  echo "output: $abs_out" >&2
fi