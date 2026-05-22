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
#   { "path": "...", "class": "...", "matches": ["SIN","EMAIL"], "matched": ["046-454-286","jane@x.com"], "message": "..." }
# CSV columns: path, level, class, matches, matched, message
#
# Detected categories:
#   SIN                  Canadian Social Insurance Number — 9 digits at strict
#                        word boundary, passes Canadian Luhn checksum.
#   SSN                  US Social Security Number — XXX-XX-XXXX format with
#                        SSA-valid area/group/serial ranges.
#   CREDIT_CARD          13-19 digit PAN, Luhn-validated AND starting with a
#                        real card brand prefix (Visa/MC/Amex/Discover/Diners/
#                        JCB). Rejects unix-ms timestamps and hex tails.
#   EMAIL                RFC-ish email address.
#   PHONE_NA             North American 10-digit phone number.
#   ACCOUNT_NUM          10-17 digit run near "account"/"acct" keyword.
#   DOB                  Date near a "dob"/"dateOfBirth"/"birthDate" keyword.
#   NAME                 Labeled name field (firstName=, lastName=, etc.)
#                        — generic name detection is not feasible by regex.
#   DRIVERS_LICENSE      Provincial DL formats (Ontario A1234-12345-12345 etc.)
#                        gated by "license"/"driver"/"permit"/"DL" keyword.
#   PASSPORT             Canadian (AB123456) / US (9-digit) gated by keyword.
#   BIOMETRIC            Mention of biometric concept (fingerprint, voiceprint,
#                        facial recognition, etc.) — actual biometric data
#                        is not regex-detectable.
#   SENSITIVE_CATEGORY   Mention of sensitive data categories (payment history,
#                        credit report, transaction history, etc.).
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
  def extract_level:
    [ scan("\\s(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|SEVERE)\\s") ]
    | if length == 0 then ""
      else .[0] | if type == "array" then .[0] else . end
      end;
  ( .rawResponse // . ) as $r
  | $r.hits.hits[]
  | {
      path:    (._source.log.file.path // ""),
      message: (._source.message // ""),
      level:   ((._source.message // "") | extract_level),
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
# ---------------------------------------------------------------------------
# Classify one message; prints zero or more "LABEL|matched_text" lines, one
# per detection. Empty output means no PII.
# ---------------------------------------------------------------------------
classify() {
  local msg="$1"
  local lower
  lower=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')

  # Helper: emit a finding. Strips control chars from the matched text and
  # truncates absurdly long matches so the CSV stays readable.
  emit() {
    local label="$1"
    local text="$2"
    text=$(printf '%s' "$text" | tr -d '\r\n\t' | cut -c1-200)
    printf '%s|%s\n' "$label" "$text"
  }

  # ===========================================================================
  # SIN (Canadian Social Insurance Number)
  # ===========================================================================
  # 9 digits with optional dash/space separators, non-hex boundaries, Canadian
  # Luhn checksum, not all-zeros or all-same-digit.
  if [[ "$msg" =~ (^|[^0-9])([0-9]{3}[-\ ]?[0-9]{3}[-\ ]?[0-9]{3})([^0-9]|$) ]]; then
    local before="${BASH_REMATCH[1]}"
    local raw="${BASH_REMATCH[2]}"
    local after="${BASH_REMATCH[3]}"
    local stripped
    stripped=$(printf '%s' "$raw" | tr -d -- '- ')
    if [[ ! "$before" =~ [a-fA-F] ]] \
       && [[ ! "$after" =~ [a-fA-F] ]] \
       && [ "${#stripped}" -eq 9 ] \
       && [ "$stripped" != "000000000" ] \
       && ! [[ "$stripped" =~ ^(.)\1{8}$ ]] \
       && luhn_ok "$stripped"; then
      emit SIN "$raw"
    fi
  fi

  # ===========================================================================
  # SSN (US Social Security Number)
  # ===========================================================================
  # Format: XXX-XX-XXXX, with strict word boundaries to avoid hex/phone matches.
  # Per SSA rules: area (first 3) cannot be 000, 666, or 900-999;
  # group (middle 2) cannot be 00; serial (last 4) cannot be 0000.
  if [[ "$msg" =~ (^|[^0-9a-fA-F])([0-9]{3}-[0-9]{2}-[0-9]{4})([^0-9a-fA-F]|$) ]]; then
    local raw="${BASH_REMATCH[2]}"
    local area="${raw:0:3}"
    local group="${raw:4:2}"
    local serial="${raw:7:4}"
    if [ "$area" != "000" ] && [ "$area" != "666" ] \
       && [ "$area" -lt 900 ] \
       && [ "$group" != "00" ] \
       && [ "$serial" != "0000" ]; then
      emit SSN "$raw"
    fi
  fi

  # ===========================================================================
  # CREDIT_CARD (PAN)
  # ===========================================================================
  # 13-19 digit run, non-hex boundaries, Luhn-validated, recognized PAN prefix.
  # LC_ALL=C forces awk to treat input as raw bytes (not UTF-8) — banking logs
  # often contain non-UTF-8 byte sequences (Latin-1 fragments, embedded nulls,
  # binary payload dumps) that would otherwise crash macOS awk's wide-char
  # conversion with "towc: multibyte conversion failure".
  # `|| true` so a single bad-encoding row can't kill the whole scan via set -e.
  local cc_found
  cc_found=$(printf '%s' "$msg" | LC_ALL=C awk '
    {
      n = length($0); i = 1
      while (i <= n) {
        if (substr($0, i, 1) ~ /[0-9]/) {
          j = i
          while (j <= n && substr($0, j, 1) ~ /[0-9]/) j++
          run = substr($0, i, j - i)
          if (length(run) >= 13 && length(run) <= 19) {
            before = (i > 1) ? substr($0, i - 1, 1) : ""
            after  = (j <= n) ? substr($0, j, 1) : ""
            if (before !~ /[a-fA-F]/ && after !~ /[a-fA-F]/) print run
          }
          i = j
        } else { i++ }
      }
    }' 2>/dev/null || true)
  if [ -n "$cc_found" ]; then
    local cc
    while IFS= read -r cc; do
      [ -z "$cc" ] && continue
      case "$cc" in
        4*|51*|52*|53*|54*|55*|22*|23*|24*|25*|26*|270*|271*|2720*|34*|37*|6011*|65*|644*|645*|646*|647*|648*|649*|300*|301*|302*|303*|304*|305*|36*|38*|39*) ;;
        *) continue ;;
      esac
      if luhn_ok "$cc"; then
        emit CREDIT_CARD "$cc"
        break
      fi
    done <<< "$cc_found"
  fi

  # ===========================================================================
  # EMAIL
  # ===========================================================================
  if [[ "$msg" =~ [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,} ]]; then
    emit EMAIL "${BASH_REMATCH[0]}"
  fi

  # ===========================================================================
  # PHONE_NA (North American 10-digit phone number)
  # ===========================================================================
  if [[ "$msg" =~ (^|[^0-9])(\(?[2-9][0-9]{2}\)?[-.\ ][0-9]{3}[-.\ ][0-9]{4})($|[^0-9]) ]]; then
    emit PHONE_NA "${BASH_REMATCH[2]}"
  fi

  # ===========================================================================
  # ACCOUNT_NUM
  # ===========================================================================
  # 10-17 digit run within ~20 chars of "account"/"acct".
  if [[ "$msg" =~ ([Aa]ccount|[Aa]cct)[^0-9]{0,20}([0-9]{10,17}) ]]; then
    emit ACCOUNT_NUM "${BASH_REMATCH[0]}"
  fi

  # ===========================================================================
  # DOB (Date of Birth)
  # ===========================================================================
  # Find the date that's *near* the keyword (within ~30 chars), not the first
  # date in the message — which would always be the log line's leading timestamp.
  if [[ "$lower" =~ (^|[^a-z])(dob|dateofbirth|birthdate|date[\ ._-]of[\ ._-]birth|birth[\ ._-]date)[^a-z][^a-z0-9]{0,30}((19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])) ]]; then
    emit DOB "${BASH_REMATCH[2]}=${BASH_REMATCH[3]}"
  elif [[ "$lower" =~ (^|[^a-z])(dob|dateofbirth|birthdate|date[\ ._-]of[\ ._-]birth|birth[\ ._-]date)[^a-z][^a-z0-9]{0,30}((0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])/(19|20)[0-9]{2}) ]]; then
    emit DOB "${BASH_REMATCH[2]}=${BASH_REMATCH[3]}"
  fi

  # ===========================================================================
  # NAME (only field labels with a following value — names themselves are
  # impossible to detect generically without an NLP model)
  # ===========================================================================
  # firstName=, lastName=, fullName=, customerName=, givenName=, surname=,
  # familyName=, middleName= etc., followed by an alphabetic value.
  if [[ "$msg" =~ ((first|last|full|customer|given|family|middle|sur)[Nn]ame|surname)[[:space:]]*[:=][[:space:]]*[\"\']?([A-Z][a-zA-Z\'-]{1,40}) ]]; then
    emit NAME "${BASH_REMATCH[0]}"
  fi

  # ===========================================================================
  # DRIVERS_LICENSE
  # ===========================================================================
  # Gated by a keyword ("licen[cs]e", "DL", "drivers", "permit") to avoid
  # matching random alphanumeric IDs. Then check Canadian provincial formats:
  #   Ontario:   1 letter + 14 digits, often A1234-12345-12345
  #   Quebec:    1 letter + 12 digits
  #   BC:        7 digits
  #   Alberta:   6 digits
  # Plus generic 7-9 char alphanumeric near a keyword.
  if [[ "$lower" =~ (licen[cs]e|driver|\<dl\>|permit) ]]; then
    # Ontario: A1234-12345-12345
    if [[ "$msg" =~ ([A-Z][0-9]{4}-[0-9]{5}-[0-9]{5}) ]]; then
      emit DRIVERS_LICENSE "${BASH_REMATCH[1]}"
    # Generic: 1 letter + 12-14 digits (unseparated)
    elif [[ "$msg" =~ (^|[^A-Za-z0-9])([A-Z][0-9]{12,14})([^A-Za-z0-9]|$) ]]; then
      emit DRIVERS_LICENSE "${BASH_REMATCH[2]}"
    fi
  fi

  # ===========================================================================
  # PASSPORT
  # ===========================================================================
  # Gated by "passport" keyword. Canadian: 2 letters + 6 digits.
  # US: 9 digits (overlaps with SSN — only flag when keyword present).
  if [[ "$lower" =~ passport ]]; then
    if [[ "$msg" =~ (^|[^A-Za-z0-9])([A-Z]{2}[0-9]{6})([^A-Za-z0-9]|$) ]]; then
      emit PASSPORT "${BASH_REMATCH[2]}"
    elif [[ "$msg" =~ passport[^A-Za-z0-9]{1,10}([0-9]{9}) ]]; then
      emit PASSPORT "passport ${BASH_REMATCH[1]}"
    fi
  fi

  # ===========================================================================
  # BIOMETRIC (mentions only — biometric data itself isn't a regex-detectable
  # pattern. Flag the keyword so the human can investigate.)
  # ===========================================================================
  if [[ "$lower" =~ (fingerprint|voiceprint|voice[\ ._-]pattern|facial[\ ._-]recognition|biometric[\ ._-](template|data|sample)|face[\ ._-]template|iris[\ ._-]scan|retina[\ ._-]scan) ]]; then
    emit BIOMETRIC "${BASH_REMATCH[1]}"
  fi

  # ===========================================================================
  # SENSITIVE_CATEGORY (category mentions — payment history, credit reports,
  # purchases — these aren't patterns either, just labels)
  # ===========================================================================
  if [[ "$lower" =~ (payment[\ ._-]history|transaction[\ ._-]history|credit[\ ._-]report|credit[\ ._-]score|purchase[\ ._-]history) ]]; then
    emit SENSITIVE_CATEGORY "${BASH_REMATCH[1]}"
  fi
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
  raw_findings=$(classify "$msg")
  if [ -n "$raw_findings" ]; then
    flagged=$(( flagged + 1 ))

    # Parse "LABEL|text" lines into two parallel ;-joined strings:
    #   labels     -> "SIN;CREDIT_CARD"      (unique, in detection order)
    #   matched    -> "046-454-286;4532...."  (one entry per finding)
    labels=""
    matched=""
    while IFS='|' read -r lbl txt; do
      [ -z "$lbl" ] && continue
      # Dedupe labels.
      case ";$labels;" in
        *";$lbl;"*) ;;
        *) labels="${labels:+$labels;}$lbl" ;;
      esac
      # Sanitize text: replace ; with , so the ;-joined column round-trips,
      # collapse whitespace.
      txt=$(printf '%s' "$txt" | tr ';' ',' | tr -s '[:space:]' ' ')
      matched="${matched:+$matched;}$txt"
    done <<< "$raw_findings"

    if [ "$MODE" = "report" ]; then
      path=$(printf '%s' "$row" | jq -r '.path')
      class=$(printf '%s' "$row" | jq -r '.class')
      level=$(printf '%s' "$row" | jq -r '.level')
      printf -- '----\nMATCHES : %s\nMATCHED : %s\nLEVEL   : %s\nPATH    : %s\nCLASS   : %s\nMESSAGE : %s\n' \
        "$labels" "$matched" "$level" "$path" "$class" "$msg"
    elif [ "$MODE" = "csv" ]; then
      # First flagged row: emit a UTF-8 BOM and header.
      if [ "$flagged" -eq 1 ]; then
        printf '\xef\xbb\xbf'
        printf '%s\n' '"path","level","class","matches","matched","message"'
      fi
      # Flatten newlines/tabs in the message so each log stays on one CSV row.
      printf '%s' "$row" \
        | jq -r --arg labels "$labels" --arg matched "$matched" '
            [.path,
             .level,
             .class,
             $labels,
             $matched,
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
        | jq -c --arg labels "$labels" --arg matched "$matched" '
            . + {
              matches: ($labels | split(";")),
              matched: ($matched | split(";"))
            }
            | { path, level, class, matches, matched, message }
          '
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
  printf '%s\n' '"path","level","class","matches","matched","message"'
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