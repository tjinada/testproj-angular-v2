#!/usr/bin/env bash
#
# find-errors.sh — count error code occurrences in OpenSearch JSON log dumps.
#
# Usage:
#   ./find-errors.sh <input.json> "CODE1,CODE2,CODE3"
#   ./find-errors.sh <input.json> "CODE1,CODE2,CODE3" matches.csv
#
# Counts UNIQUE log lines per code (deduped by exact message string) and
# writes EVERY matching occurrence to a CSV so you can also see raw volume.
#
# Example:
#   ./find-errors.sh logs.json "SI/D/622,SI/D/612,SI/H/331" errors.csv
#
# Compatibility: bash 3.2+ (Apple stock /bin/bash).
# Exit codes: 0 ok, 1 bad usage, 2 jq missing, 3 input not readable.

set -eo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq required but not on PATH" >&2
  exit 2
fi

if [ "$#" -lt 2 ]; then
  cat >&2 <<USAGE
usage: $0 <input.json> "CODE1,CODE2,CODE3" [out.csv]

  <input.json>   OpenSearch search response JSON (rawResponse or bare)
  CODE...        Comma-separated list of error codes to count
  [out.csv]      Optional CSV output path (default: error-matches.csv)

example:
  $0 logs.json "SI/D/622,SI/D/612,SI/H/331" errors.csv
USAGE
  exit 1
fi

INPUT="$1"
CODES_ARG="$2"
OUT_FILE="${3:-error-matches.csv}"

if [ ! -r "$INPUT" ]; then
  echo "error: cannot read $INPUT" >&2
  exit 3
fi

# Resolve absolute output path so the user knows where the CSV lands.
case "$OUT_FILE" in
  /*) abs_out="$OUT_FILE" ;;
  *)  abs_out="$PWD/$OUT_FILE" ;;
esac

# Temp files for staging — cleaned up on exit.
TMP_MATCHES="${TMPDIR:-/tmp}/find-errors-matches.$$"
TMP_CODES="${TMPDIR:-/tmp}/find-errors-codes.$$"
trap 'rm -f "$TMP_MATCHES" "$TMP_CODES"' EXIT

echo "scanning:   $INPUT" >&2
echo "codes:      $CODES_ARG" >&2
echo "CSV output: $abs_out" >&2
echo "" >&2

# ----------------------------------------------------------------------------
# Stage 1: single jq pass emits one JSON object per (code, log) match.
# Substring match via jq's `contains` — the slashes in codes (SI/D/622)
# make false collisions extremely unlikely.
# ----------------------------------------------------------------------------
MATCHES=$(jq -c --arg codes "$CODES_ARG" '
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
  ( $codes
    | split(",")
    | map(gsub("^\\s+|\\s+$"; ""))
    | map(select(length > 0))
  ) as $codelist
  | ( .rawResponse // . ) as $r
  | $r.hits.hits[]?
  | (._source.message // "") as $msg
  | (._source.log.file.path // "") as $path
  | ($msg | extract_level) as $level
  | ($msg | extract_class) as $class
  | $codelist[] as $code
  | select($msg | contains($code))
  | { code: $code, path: $path, level: $level, class: $class, message: $msg }
' "$INPUT")

# Total row count for the footer.
TOTAL_ROWS=$(jq '[( .rawResponse // . ).hits.hits[]?] | length' "$INPUT")

# ----------------------------------------------------------------------------
# Stage 2: write CSV — every matching occurrence (no dedup), BOM + header
# for Excel-friendly UTF-8 open. Embedded newlines/tabs in messages get
# flattened so each match stays on one CSV row.
# ----------------------------------------------------------------------------
{
  printf '\xef\xbb\xbf'
  printf '%s\n' '"code","path","level","class","message"'
  if [ -n "$MATCHES" ]; then
    printf '%s\n' "$MATCHES" | jq -r '
      [.code, .path, .level, .class,
       (.message
          | gsub("\r\n"; "\\n")
          | gsub("\n";   "\\n")
          | gsub("\r";   "\\n")
          | gsub("\t";   "\\t"))]
      | @csv'
  fi
} > "$OUT_FILE"

# ----------------------------------------------------------------------------
# Stage 3: summary — per code, unique count + total count + sample message.
# Codes with zero matches still appear with 0 so nothing's overlooked.
# ----------------------------------------------------------------------------
# Codes preserved in input order so the summary lines up with what was asked.
printf '%s' "$CODES_ARG" \
  | tr ',' '\n' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -v '^$' > "$TMP_CODES"

# TSV of all matches (code \t message) for awk to chew on.
if [ -n "$MATCHES" ]; then
  printf '%s\n' "$MATCHES" | jq -r '[.code, .message] | @tsv' > "$TMP_MATCHES"
else
  : > "$TMP_MATCHES"
fi

SUMMARY=$(
  awk -F'\t' '
    # First file: codes in order.
    NR==FNR { order[++n] = $1; want[$1] = 1; next }
    # Second file: matches.
    {
      c = $1
      # Reconstruct message (in case the message had embedded tabs awk split on)
      m = $2
      for (i = 3; i <= NF; i++) m = m "\t" $i
      total[c]++
      key = c SUBSEP m
      if (!(key in seen)) {
        seen[key] = 1
        uniq[c]++
        if (!(c in sample)) sample[c] = m
      }
    }
    END {
      for (i = 1; i <= n; i++) {
        c = order[i]
        u = (c in uniq)  ? uniq[c]  : 0
        t = (c in total) ? total[c] : 0
        s = (c in sample) ? sample[c] : "(no matches)"
        if (length(s) > 90) s = substr(s, 1, 87) "..."
        printf "%s\t%d\t%d\t%s\n", c, u, t, s
      }
    }
  ' "$TMP_CODES" "$TMP_MATCHES"
)

# Print aligned summary using awk (avoids dependency on `column`).
echo "=== Summary ==="
{
  printf 'CODE\tUNIQUE\tTOTAL\tSAMPLE\n'
  printf '%s\n' "$SUMMARY"
} | awk -F'\t' '
  { for (i = 1; i <= NF; i++) { rows[NR,i] = $i; if (length($i) > w[i]) w[i] = length($i) } R = NR; C = NF }
  END {
    for (r = 1; r <= R; r++) {
      for (c = 1; c <= C; c++) {
        if (c < C) printf "%-*s  ", w[c], rows[r,c]
        else       printf "%s\n",      rows[r,c]
      }
    }
  }
'

echo ""
echo "scanned $TOTAL_ROWS log rows"
echo "CSV written to: $abs_out"