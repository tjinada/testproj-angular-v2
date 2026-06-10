#!/usr/bin/env bash
#
# repo-size-audit.sh
# -----------------------------------------------------------------------------
# Audit a GitHub repo for size-reduction opportunities via the GitHub API
# (REST + GraphQL, both under api.github.com).
#
# Reports:
#   1. Repo overview        - total size, branch/tag counts, default branch
#   2. Stale branches       - no commits in the last N months (default 6)
#   3. Merge status         - is each stale branch already contained in a
#                             release/r* branch (or the default branch)?
#   4. Largest files        - biggest blobs currently tracked on the default
#                             branch, plus a size-by-extension breakdown
#   5. Recommendations      - actionable cleanup summary + CSV export
#
# Requirements : bash 4+, curl, jq
# Auth         : export GITHUB_TOKEN=<PAT with repo:read>   (required)
# Usage        : ./repo-size-audit.sh <owner> <repo>
#
# Tunables (env vars):
#   STALE_MONTHS     staleness threshold in months         (default 6)
#   RELEASE_PREFIX   prefix used to detect release branches (default "release/r")
#   TOP_FILES        how many largest files to list         (default 25)
#   MAX_RELEASE_CHK  cap release branches checked per stale branch, 0 = all (default 0)
#
# NOTE on "largest files": the GitHub API only exposes the CURRENT tree, i.e.
# what's checked out on a branch right now. It does NOT reflect what's bloating
# the .git history (deleted-but-still-packed large objects). For that you need a
# clone + git-filter-repo / BFG. See analyze_history_locally() at the bottom.
# -----------------------------------------------------------------------------

set -euo pipefail

# ----------------------------- config ----------------------------------------
# Load .env if present (default ./.env, override with ENV_FILE=/path/to/.env).
# Lines are KEY=value; `set -a` exports them so the assignments below pick them up.
ENV_FILE="${ENV_FILE:-.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# --- mode ---------------------------------------------------------------------
# Two modes:
#   audit    (default)  full report: overview, stale branches, merge status, files
#   history             ONLY the historical largest-objects analysis on a clone
# Select history mode with first arg `history`/`--history`, or HISTORY_ONLY=1.
MODE="audit"
case "${1:-}" in
  history|--history|hist) MODE="history"; shift ;;
esac
[[ "${HISTORY_ONLY:-0}" == "1" ]] && MODE="history"

# Positional args (after any subcommand) override .env values for owner/repo.
OWNER="${1:-${OWNER:-}}"
REPO="${2:-${REPO:-}}"
API="https://api.github.com"
TOKEN="${GITHUB_TOKEN:-}"
STALE_MONTHS="${STALE_MONTHS:-6}"
RELEASE_PREFIX="${RELEASE_PREFIX:-release/r}"
# A branch counts as a real release ONLY if it matches this regex. Default accepts
# release/r<NUM>[.<NUM>...] (e.g. release/r92, release/r51.1.3) and rejects junk like
# release/r10001-test-dss-devops-standardization. Override if your scheme differs.
RELEASE_REGEX="${RELEASE_REGEX:-^release/r[0-9]+([.][0-9]+)*$}"
TOP_FILES="${TOP_FILES:-25}"
MAX_RELEASE_CHK="${MAX_RELEASE_CHK:-0}"
LOCAL_REPO="${LOCAL_REPO:-}"                   # existing local clone (for history mode)
HISTORY_CSV_ROWS="${HISTORY_CSV_ROWS:-500}"    # rows written to the history CSVs

STALE_SECS=$(( STALE_MONTHS * 2629800 ))   # ~30.44 days/month

WORKDIR="$(pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bar() { printf '%s\n' "------------------------------------------------------------"; }
log() { printf '%s\n' "$*" >&2; }

# Bytes -> human-readable with explicit B/KB/MB/GB/TB units (1024-based).
# Self-contained (no numfmt dependency, so it works on stock macOS too).
human() {
  awk -v b="${1:-0}" 'BEGIN{
    split("B KB MB GB TB PB", u, " ");
    i=1; x=b+0;
    while (x>=1024 && i<6){ x/=1024; i++ }
    if (i==1) printf "%d %s", x, u[i];
    else      printf "%.1f %s", x, u[i];
  }'
}

# Label used for output filenames: REPO if known, else the clone's directory name.
if   [[ -n "$REPO"       ]]; then REPO_LABEL="$REPO"
elif [[ -n "$LOCAL_REPO" ]]; then REPO_LABEL="$(basename "$LOCAL_REPO")"
else REPO_LABEL="repo"; fi

# ----------------------------- preflight --------------------------------------
command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
if [[ "$MODE" == "history" ]]; then
  if [[ -z "$LOCAL_REPO" && ( -z "$OWNER" || -z "$REPO" ) ]]; then
    echo "error: history mode needs LOCAL_REPO=/path/to/clone (preferred)," >&2
    echo "       or OWNER/REPO so it can clone. e.g.:" >&2
    echo "         LOCAL_REPO=/path/to/clone $0 history" >&2
    exit 1
  fi
else
  if [[ -z "$OWNER" || -z "$REPO" ]]; then
    echo "error: OWNER and REPO required (set in $ENV_FILE or pass as args)" >&2
    echo "usage: $0 [owner] [repo]      # full audit" >&2
    echo "       $0 history             # history-only (needs LOCAL_REPO=/path/to/clone)" >&2
    exit 1
  fi
  [[ -z "$TOKEN" ]] && { echo "error: set GITHUB_TOKEN (PAT with repo:read scope)" >&2; exit 1; }
  command -v jq   >/dev/null || { echo "error: jq is required"   >&2; exit 1; }
  command -v curl >/dev/null || { echo "error: curl is required" >&2; exit 1; }
fi

# ----------------------------- API helpers ------------------------------------
# REST GET -> body on stdout, fails on non-2xx.
rest() {
  local url="$1"
  [[ "$url" == http* ]] || url="$API$url"
  curl -fsSL \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$url"
}

# REST GET that returns body even on error status (so we can inspect 404 etc.)
rest_soft() {
  local url="$1"
  [[ "$url" == http* ]] || url="$API$url"
  curl -sSL \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$url"
}

# GraphQL POST: $1 = query, $2 = variables JSON (defaults to {})
graphql() {
  curl -fsSL -X POST "$API/graphql" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg q "$1" --argjson v "${2:-'{}'}" '{query:$q, variables:$v}')"
}

# ----------------------------- history analysis -------------------------------
# Surfaces the largest objects across ALL git history - what actually determines
# .git size, and the API's blind spot. Uses LOCAL_REPO if set, else bare-clones.
# Emits two CSVs to the current directory:
#   largest-objects-<repo>.csv : biggest individual blobs (sha,bytes,human,path)
#   largest-paths-<repo>.csv   : biggest paths by total bytes summed over all
#                                their historical versions (the filter-repo target)
analyze_history_locally() {
  local gitdir TAB; TAB="$(printf '\t')"
  if [[ -n "$LOCAL_REPO" ]]; then
    [[ -d "$LOCAL_REPO" ]] || { log "LOCAL_REPO '$LOCAL_REPO' does not exist"; return 1; }
    git -C "$LOCAL_REPO" rev-parse --git-dir >/dev/null 2>&1 \
      || { log "LOCAL_REPO '$LOCAL_REPO' is not a git repo"; return 1; }
    gitdir="$LOCAL_REPO"
    log ">> analyzing existing clone at $gitdir"
    log "   (reflects refs present locally - 'git -C $gitdir fetch --all --prune' for full coverage)"
  else
    gitdir="$TMP/clone"
    log ">> no LOCAL_REPO; bare-cloning $OWNER/$REPO for history analysis (slow)..."
    git clone --bare "https://github.com/$OWNER/$REPO.git" "$gitdir" 2>/dev/null \
      || { log "clone failed"; return 1; }
  fi

  log ">> writing commit-graph + enumerating every object across all history (one pass)..."
  git -C "$gitdir" commit-graph write --reachable 2>/dev/null || true

  # Single expensive pass: every blob across ALL refs -> "sha<TAB>size<TAB>path".
  # rev-list --objects dedupes by sha, so each blob version is counted once.
  local raw="$TMP/objects.tsv"
  git -C "$gitdir" rev-list --objects --all \
    | git -C "$gitdir" cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
    | awk '$1=="blob"{ sha=$2; size=$3; path=$0; sub(/^[^ ]+ [^ ]+ [^ ]+ /,"",path);
                       printf "%s\t%s\t%s\n", sha, size, path }' \
    > "$raw"

  if [[ ! -s "$raw" ]]; then log "no objects found (empty/shallow repo?)"; return 1; fi

  local OBJ_CSV="$WORKDIR/largest-objects-${REPO_LABEL}.csv"
  local PATH_CSV="$WORKDIR/largest-paths-${REPO_LABEL}.csv"

  # ---- largest individual objects ----
  sort -t"$TAB" -k2,2 -nr "$raw" > "$TMP/objects.sorted"
  bar; echo "HISTORY: largest individual objects across ALL refs (top $TOP_FILES)"; bar
  printf "%12s  %s\n" "SIZE" "PATH"
  head -n "$TOP_FILES" "$TMP/objects.sorted" | while IFS=$'\t' read -r sha size path; do
    printf "%12s  %s\n" "$(human "$size")" "${path:-(no path)}"
  done
  echo "object_sha,size_bytes,size_human,path" > "$OBJ_CSV"
  head -n "$HISTORY_CSV_ROWS" "$TMP/objects.sorted" | while IFS=$'\t' read -r sha size path; do
    printf '%s,%s,"%s","%s"\n' "$sha" "$size" \
      "$(human "$size")" "${path//\"/\"\"}" >> "$OBJ_CSV"
  done

  # ---- largest paths by total bytes across all versions ----
  awk -F'\t' '{s[$3]+=$2; c[$3]++} END{for(p in s) printf "%d\t%d\t%s\n", s[p], c[p], p}' "$raw" \
    | sort -t"$TAB" -k1,1 -nr > "$TMP/paths.sorted"
  bar; echo "HISTORY: largest PATHS by total bytes over all versions (top $TOP_FILES)"; bar
  echo "(best signal for what to purge with 'git filter-repo --path <p> --invert-paths')"
  printf "%12s  %6s  %s\n" "TOTAL" "VERS" "PATH"
  head -n "$TOP_FILES" "$TMP/paths.sorted" | while IFS=$'\t' read -r total vers path; do
    printf "%12s  %6s  %s\n" "$(human "$total")" "$vers" "$path"
  done
  echo "path,total_bytes,total_human,versions" > "$PATH_CSV"
  head -n "$HISTORY_CSV_ROWS" "$TMP/paths.sorted" | while IFS=$'\t' read -r total vers path; do
    printf '"%s",%s,%s,%s\n' "${path//\"/\"\"}" "$total" \
      "$(human "$total")" "$vers" >> "$PATH_CSV"
  done

  echo
  echo "  -> CSV: $OBJ_CSV"
  echo "  -> CSV: $PATH_CSV"
  if [[ -n "$LOCAL_REPO" ]]; then
    echo "On-disk .git size:"; du -sh "$gitdir" 2>/dev/null | awk '{print "  " $1}'
  fi
}

# History-only mode: run just the analysis and exit before any API calls.
if [[ "$MODE" == "history" ]]; then
  bar; echo "Git history size analysis :: ${OWNER:+$OWNER/}$REPO_LABEL"; bar
  analyze_history_locally || exit 1
  bar; echo "Done (history mode)."; bar
  exit 0
fi

# ----------------------------- 0. rate limit ----------------------------------
bar
echo "GitHub repo size audit :: $OWNER/$REPO"
bar
rl="$(rest /rate_limit)"
echo "Rate limit  core: $(jq -r '.resources.core.remaining'    <<<"$rl")/$(jq -r '.resources.core.limit'    <<<"$rl") remaining"
echo "          graphql: $(jq -r '.resources.graphql.remaining' <<<"$rl")/$(jq -r '.resources.graphql.limit' <<<"$rl") remaining"
echo "Stale threshold : ${STALE_MONTHS} months   Release prefix: '${RELEASE_PREFIX}'"

# ----------------------------- 1. repo overview -------------------------------
bar; echo "1. REPO OVERVIEW"; bar
repo_json="$(rest "/repos/$OWNER/$REPO")"
DEFAULT_BRANCH="$(jq -r '.default_branch' <<<"$repo_json")"
size_kb="$(jq -r '.size' <<<"$repo_json")"   # KB, includes .git
printf "Default branch : %s\n" "$DEFAULT_BRANCH"
printf "Repo size      : %s  (GitHub-reported, includes git history)\n" \
  "$(human "$(( size_kb * 1024 ))")"

# branch + tag totals via GraphQL (single call each, cheap)
counts="$(graphql 'query($o:String!,$r:String!){repository(owner:$o,name:$r){
  branches:refs(refPrefix:"refs/heads/"){totalCount}
  tags:refs(refPrefix:"refs/tags/"){totalCount}}}' \
  "$(jq -n --arg o "$OWNER" --arg r "$REPO" '{o:$o,r:$r}')")"
TOTAL_BRANCHES="$(jq -r '.data.repository.branches.totalCount' <<<"$counts")"
TOTAL_TAGS="$(jq -r '.data.repository.tags.totalCount' <<<"$counts")"
printf "Branches       : %s\n" "$TOTAL_BRANCHES"
printf "Tags           : %s\n" "$TOTAL_TAGS"

# ----------------------------- 2+3. branches ----------------------------------
# Enumerate ALL branches with their last-commit date via GraphQL (100/call).
log ">> fetching branches (GraphQL, paginated)..."
: > "$TMP/branches.ndjson"
cursor="null"
while :; do
  vars="$(jq -n --arg o "$OWNER" --arg r "$REPO" --argjson c "$cursor" '{o:$o,r:$r,c:$c}')"
  page="$(graphql 'query($o:String!,$r:String!,$c:String){repository(owner:$o,name:$r){
    refs(refPrefix:"refs/heads/",first:100,after:$c){
      pageInfo{hasNextPage endCursor}
      nodes{name target{... on Commit{committedDate oid}}}}}}' "$vars")"
  jq -c '.data.repository.refs.nodes[]
         | {name, date:.target.committedDate, oid:.target.oid}' \
    <<<"$page" >> "$TMP/branches.ndjson"
  has_next="$(jq -r '.data.repository.refs.pageInfo.hasNextPage' <<<"$page")"
  [[ "$has_next" == "true" ]] || break
  cursor="$(jq -c '.data.repository.refs.pageInfo.endCursor' <<<"$page")"
done

# Real release branches (strict regex match), sorted version-desc so newest first.
RELEASE_BRANCHES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && RELEASE_BRANCHES+=("$line")
done < <(
  jq -r --arg re "$RELEASE_REGEX" 'select(.name|test($re)) | .name' "$TMP/branches.ndjson" \
  | { sort -rV 2>/dev/null || sort -t r -k2 -n -r; }
)
echo "Release branches matching /${RELEASE_REGEX}/: ${#RELEASE_BRANCHES[@]}"
(( ${#RELEASE_BRANCHES[@]} )) && printf '  - %s\n' "${RELEASE_BRANCHES[@]}"

# Stale branches: now - committedDate > threshold. All math in jq (portable).
# Excludes the default branch and real release branches (which we treat as targets,
# not cleanup candidates). Note: junk like release/r10001-test-* does NOT match the
# release regex, so it WILL show up here as a review candidate - which is what we want.
jq -c --argjson cut "$STALE_SECS" --arg def "$DEFAULT_BRANCH" --arg re "$RELEASE_REGEX" '
  ( (now - (.date | fromdateiso8601)) ) as $age
  | select($age > $cut)
  | select(.name != $def)              # never flag the default branch
  | select(.name|test($re)|not)        # don'\''t flag real release branches
  | {name, date, oid, age_days: (($age/86400)|floor)}
' "$TMP/branches.ndjson" | jq -s 'sort_by(.age_days) | reverse' > "$TMP/stale.json"

STALE_COUNT="$(jq 'length' "$TMP/stale.json")"

bar; echo "2 + 3. STALE BRANCHES (> ${STALE_MONTHS} months) & MERGE STATUS"; bar
echo "Found $STALE_COUNT stale branches (excludes default + release/* branches)."

# --- Merge detection -----------------------------------------------------------
# Goal: for each stale branch tip, find a release (or the default branch) that
# already CONTAINS it (i.e. it's merged and safe to delete).
#
# Naive approach = `git merge-base --is-ancestor <tip> <release>` for every
# (branch x release) pair => tens of thousands of git process spawns + history
# walks. Far too slow on a big monolith.
#
# Fast approach (local): walk each release exactly ONCE with `git rev-list` to get
# the set of commits it contains, then bulk set-membership the branch tips against
# that set with `join`. ~N_releases walks total instead of N_branches x N_releases.
# A commit-graph makes those walks dramatically faster, so we write one first.
#
# Releases are processed newest-first and a tip is removed from the "unresolved"
# pool as soon as a containing release is found, so older releases only get walked
# for the leftovers. MAX_RELEASE_CHK caps how many releases to walk.

DEFAULT_OID="$(jq -r --arg d "$DEFAULT_BRANCH" 'select(.name==$d) | .oid' "$TMP/branches.ndjson" | head -1)"
jq -r --arg re "$RELEASE_REGEX" 'select(.name|test($re)) | "\(.name)\t\(.oid)"' \
  "$TMP/branches.ndjson" > "$TMP/release_raw.tsv"
sort -rV "$TMP/release_raw.tsv" 2>/dev/null > "$TMP/release_pairs.tsv" \
  || sort -r "$TMP/release_raw.tsv" > "$TMP/release_pairs.tsv"

USE_LOCAL_MERGE=0
if [[ -n "$LOCAL_REPO" ]] && command -v git >/dev/null \
   && git -C "$LOCAL_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  USE_LOCAL_MERGE=1
  present=0; sample=0
  while IFS= read -r oid; do
    sample=$((sample+1)); (( sample > 200 )) && break
    git -C "$LOCAL_REPO" cat-file -e "${oid}^{commit}" 2>/dev/null && present=$((present+1)) || true
  done < <(jq -r '.[].oid' "$TMP/stale.json")
  log ">> local merge mode: $present/$sample sampled stale tips present in $LOCAL_REPO"
  if (( sample > 0 && present * 100 / sample < 80 )); then
    log "   WARNING: many tips missing locally - run 'git -C $LOCAL_REPO fetch --all --prune' first."
  fi
  log ">> writing commit-graph for fast history walks (one-time; speeds everything below)..."
  git -C "$LOCAL_REPO" commit-graph write --reachable --changed-paths 2>/dev/null \
    || git -C "$LOCAL_REPO" commit-graph write --reachable 2>/dev/null || true
else
  log ">> LOCAL_REPO not usable; merge checks will use the (slow, rate-limited) compare API."
fi

have_obj() { git -C "$LOCAL_REPO" cat-file -e "${1}^{commit}" 2>/dev/null; }

# API compare helper (fallback only): is $head fully contained in $base?
is_contained_in() {
  local base="$1" head="$2" ahead
  ahead="$(rest_soft "/repos/$OWNER/$REPO/compare/${base}...${head}" | jq -r '.ahead_by // empty')"
  [[ "$ahead" == "0" ]]
}

# Stale tips as: oid \t name \t date(10) \t age   (one row per stale branch)
jq -r '.[] | [.oid, .name, (.date[0:10]), .age_days] | @tsv' "$TMP/stale.json" > "$TMP/stale.tsv"

# merged_map.tsv :: oid \t merged_into_ref   (only branches that ARE contained)
: > "$TMP/merged_map.tsv"

if (( USE_LOCAL_MERGE == 1 )); then
  # unresolved pool, sorted by oid in C locale for join.
  LC_ALL=C sort -t"$(printf '\t')" -k1,1 "$TMP/stale.tsv" > "$TMP/unresolved.tsv"

  # Ordered targets: releases newest-first (capped) then the default branch.
  awk -F'\t' '{print $2"\t"$1}' "$TMP/release_pairs.tsv" > "$TMP/targets.tsv"   # oid \t name
  if (( MAX_RELEASE_CHK > 0 )); then
    head -n "$MAX_RELEASE_CHK" "$TMP/targets.tsv" > "$TMP/targets.head" && mv "$TMP/targets.head" "$TMP/targets.tsv"
  fi
  [[ -n "$DEFAULT_OID" ]] && printf '%s\t%s\n' "$DEFAULT_OID" "$DEFAULT_BRANCH" >> "$TMP/targets.tsv"

  TAB="$(printf '\t')"
  while IFS=$'\t' read -r toid tname; do
    [[ -s "$TMP/unresolved.tsv" ]] || break          # everything resolved
    have_obj "$toid" || continue
    log "   walking $tname ..."
    git -C "$LOCAL_REPO" rev-list "$toid" 2>/dev/null | LC_ALL=C sort -u > "$TMP/reach.tsv"
    [[ -s "$TMP/reach.tsv" ]] || continue
    # tips contained in this target -> record with target name
    LC_ALL=C join -t"$TAB" -1 1 -2 1 -o '1.1' "$TMP/unresolved.tsv" "$TMP/reach.tsv" \
      | awk -v t="$tname" -F'\t' '{print $1"\t"t}' >> "$TMP/merged_map.tsv"
    # keep only the tips NOT contained, for the next (older) target
    LC_ALL=C join -t"$TAB" -v 1 -1 1 -2 1 "$TMP/unresolved.tsv" "$TMP/reach.tsv" > "$TMP/unresolved.next"
    mv "$TMP/unresolved.next" "$TMP/unresolved.tsv"
  done < "$TMP/targets.tsv"
  rm -f "$TMP/reach.tsv"
else
  # API fallback: per-branch compare, newest-first, capped. Slow; used only when
  # no local clone is available.
  i=0
  while IFS=$'\t' read -r oid name date age; do
    i=$((i+1)); (( i % 25 == 0 )) && log "   ...api-checked $i/$STALE_COUNT branches"
    checked=0; target=""
    while IFS=$'\t' read -r rname roid; do
      (( MAX_RELEASE_CHK > 0 && checked >= MAX_RELEASE_CHK )) && break
      checked=$((checked+1))
      is_contained_in "$rname" "$name" && { target="$rname"; break; }
    done < "$TMP/release_pairs.tsv"
    [[ -z "$target" ]] && is_contained_in "$DEFAULT_BRANCH" "$name" && target="$DEFAULT_BRANCH"
    [[ -n "$target" ]] && printf '%s\t%s\n' "$oid" "$target" >> "$TMP/merged_map.tsv"
  done < "$TMP/stale.tsv"
fi

# Left-join stale tips with the merged map to attach target (empty => unmerged),
# then sort by age desc for display.
TAB="$(printf '\t')"
LC_ALL=C sort -t"$TAB" -k1,1 "$TMP/stale.tsv"      > "$TMP/stale.byoid"
LC_ALL=C sort -t"$TAB" -k1,1 "$TMP/merged_map.tsv" > "$TMP/merged.byoid" 2>/dev/null || : > "$TMP/merged.byoid"
LC_ALL=C join -t"$TAB" -a 1 -1 1 -2 1 -e '' -o '1.2,1.3,1.4,2.2' \
  "$TMP/stale.byoid" "$TMP/merged.byoid" > "$TMP/stale_resolved.tsv"   # name \t date \t age \t target
sort -t"$TAB" -k3,3 -nr "$TMP/stale_resolved.tsv" > "$TMP/stale_display.tsv"

# CSV export header
CSV="$WORKDIR/stale-branches-${REPO}.csv"
echo "branch,last_commit_date,age_days,merged_into,safe_to_delete" > "$CSV"

if (( STALE_COUNT > 0 )); then
  printf "\n%-50s %-9s %-12s %s\n" "BRANCH" "AGE(d)" "LAST COMMIT" "MERGED INTO"
  while IFS=$'\t' read -r name date age target; do
    disp="$name"; (( ${#disp} > 50 )) && disp="${name:0:49}>"
    if [[ -n "$target" ]]; then
      printf "%-50s %-9s %-12s \033[32m%s\033[0m\n" "$disp" "$age" "$date" "$target"
      echo "\"$name\",$date,$age,$target,YES" >> "$CSV"
    else
      printf "%-50s %-9s %-12s \033[33m%s\033[0m\n" "$disp" "$age" "$date" "(unmerged)"
      echo "\"$name\",$date,$age,,REVIEW" >> "$CSV"
    fi
  done < "$TMP/stale_display.tsv"

  merged_n="$(grep -c ',YES$' "$CSV" || true)"
  echo
  echo "  -> $merged_n / $STALE_COUNT stale branches are already merged = safe-delete candidates."
  echo "  -> CSV written: $CSV"
fi

# ----------------------------- 4. largest files -------------------------------
bar; echo "4. LARGEST FILES (current tree on '$DEFAULT_BRANCH')"; bar
log ">> fetching recursive tree..."
tree_json="$(rest "/repos/$OWNER/$REPO/git/trees/${DEFAULT_BRANCH}?recursive=1")"

if [[ "$(jq -r '.truncated' <<<"$tree_json")" == "true" ]]; then
  echo "WARNING: tree is truncated by the API (very large repo). Results are partial."
  echo "         Use analyze_history_locally() for a complete picture."
fi

echo
printf "%12s  %s\n" "SIZE" "PATH"
jq -r --argjson n "$TOP_FILES" '
  [.tree[] | select(.type=="blob") | {path, size:(.size//0)}]
  | sort_by(.size) | reverse | .[:$n]
  | .[] | "\(.size)\t\(.path)"
' <<<"$tree_json" | while IFS=$'\t' read -r size path; do
  printf "%12s  %s\n" "$(human "$size")" "$path"
done

# size-by-extension breakdown
echo
echo "Tracked size by file extension (top 15):"
printf "%12s  %8s  %s\n" "TOTAL" "COUNT" "EXT"
jq -r '
  [.tree[] | select(.type=="blob")
    | { ext: (.path | capture("(?<e>\\.[^./]+)$").e // "(none)"),
        size: (.size // 0) }]
  | group_by(.ext)
  | map({ext: .[0].ext, total: (map(.size)|add), count: length})
  | sort_by(.total) | reverse | .[:15]
  | .[] | "\(.total)\t\(.count)\t\(.ext)"
' <<<"$tree_json" | while IFS=$'\t' read -r total count ext; do
  printf "%12s  %8s  %s\n" "$(human "$total")" "$count" "$ext"
done

# ----------------------------- 5. recommendations -----------------------------
bar; echo "5. SUMMARY / RECOMMENDATIONS"; bar
cat <<EOF
- $STALE_COUNT branches are stale (> ${STALE_MONTHS}mo). Of those, the CSV marks which
  are already merged (YES) and thus safe to delete via the API:
      curl -X DELETE -H "Authorization: Bearer \$GITHUB_TOKEN" \\
        "$API/repos/$OWNER/$REPO/git/refs/heads/<branch>"
- Branches marked REVIEW carry commits not in any release/* or '$DEFAULT_BRANCH' -
  ping the owner before deleting (no data loss otherwise, but check first).
- Deleting refs alone does NOT shrink .git on the server; GitHub repacks/GCs on its
  own schedule. The real size win is purging large historical objects:
      git filter-repo --strip-blobs-bigger-than 10M
  (or BFG), then a force-push + GitHub support GC request for enterprise repos.
- Tags ($TOTAL_TAGS) also pin history. Prune obsolete release tags if they're not
  referenced by anything you still ship.
- Largest current files above are the first candidates for Git LFS migration if any
  are binaries (builds, fixtures, media) that shouldn't live in source control.

Caveat: section 4 reflects the *current tree*, not history bloat. Run the optional
local analysis for the objects actually inflating your packfiles.
EOF

# Append the history analysis to a full audit when RUN_HISTORY=1 (env or .env).
# (The function is defined near the top; history-only mode is `$0 history`.)
if [[ "${RUN_HISTORY:-0}" == "1" ]]; then
  analyze_history_locally || true
fi

bar; echo "Done."; bar