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

# Positional args (if given) override .env values for owner/repo.
OWNER="${1:-${OWNER:-}}"
REPO="${2:-${REPO:-}}"
API="https://api.github.com"
TOKEN="${GITHUB_TOKEN:-}"
STALE_MONTHS="${STALE_MONTHS:-6}"
RELEASE_PREFIX="${RELEASE_PREFIX:-release/r}"
TOP_FILES="${TOP_FILES:-25}"
MAX_RELEASE_CHK="${MAX_RELEASE_CHK:-0}"
LOCAL_REPO="${LOCAL_REPO:-}"   # path to an existing local clone for history analysis

STALE_SECS=$(( STALE_MONTHS * 2629800 ))   # ~30.44 days/month

# ----------------------------- preflight --------------------------------------
if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "error: OWNER and REPO required (set them in $ENV_FILE or pass as args)" >&2
  echo "usage: $0 [owner] [repo]" >&2
  echo "  .env example:" >&2
  echo "    GITHUB_TOKEN=ghp_xxx" >&2
  echo "    OWNER=my-org" >&2
  echo "    REPO=canadian-digital-banking" >&2
  echo "    LOCAL_REPO=/path/to/clone        # optional, for history analysis" >&2
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "error: set GITHUB_TOKEN (PAT with repo:read scope)" >&2
  exit 1
fi
command -v jq   >/dev/null || { echo "error: jq is required"   >&2; exit 1; }
command -v curl >/dev/null || { echo "error: curl is required" >&2; exit 1; }

WORKDIR="$(pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

bar() { printf '%s\n' "------------------------------------------------------------"; }
log() { printf '%s\n' "$*" >&2; }

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
printf "Repo size      : %.1f MB  (GitHub-reported, includes git history)\n" \
  "$(awk "BEGIN{print $size_kb/1024}")"

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

# Release branches (sorted by trailing number desc so newest checked first).
# Portable read loop instead of `mapfile` (bash 4+) so this runs on stock macOS bash 3.2.
RELEASE_BRANCHES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && RELEASE_BRANCHES+=("$line")
done < <(
  jq -r --arg p "$RELEASE_PREFIX" 'select(.name|startswith($p)) | .name' "$TMP/branches.ndjson" \
  | sort -t r -k2 -n -r
)
echo "Release branches matching '${RELEASE_PREFIX}*': ${#RELEASE_BRANCHES[@]}"
(( ${#RELEASE_BRANCHES[@]} )) && printf '  - %s\n' "${RELEASE_BRANCHES[@]}"

# Stale branches: now - committedDate > threshold. All math in jq (portable).
jq -c --argjson cut "$STALE_SECS" --arg def "$DEFAULT_BRANCH" --arg p "$RELEASE_PREFIX" '
  ( (now - (.date | fromdateiso8601)) ) as $age
  | select($age > $cut)
  | select(.name != $def)                 # never flag the default branch
  | select(.name|startswith($p)|not)      # don'\''t flag release branches themselves
  | {name, date, oid, age_days: (($age/86400)|floor)}
' "$TMP/branches.ndjson" | jq -s 'sort_by(.age_days) | reverse' > "$TMP/stale.json"

STALE_COUNT="$(jq 'length' "$TMP/stale.json")"

bar; echo "2 + 3. STALE BRANCHES (> ${STALE_MONTHS} months) & MERGE STATUS"; bar
echo "Found $STALE_COUNT stale branches (excludes default + release/* branches)."

# --- Merge detection -----------------------------------------------------------
# We have every branch tip SHA from the GraphQL enumeration. The fastest, rate-
# limit-free way to ask "is branch X already contained in release Y" is local git:
#   git merge-base --is-ancestor <X_tip> <Y_tip>   (exit 0 => X is contained in Y)
# So if LOCAL_REPO is set and has the objects, we do it locally (instant, free).
# Otherwise we fall back to the REST compare endpoint (slow + rate-limited).
#
# With this many release branches, a genuinely-unmerged branch would otherwise be
# compared against ALL of them. Set MAX_RELEASE_CHK (e.g. 10) to bound that tail;
# release branches are checked newest-first, so recent merges are still caught.

# Default branch tip + release (name<TAB>oid) list, newest-first.
DEFAULT_OID="$(jq -r --arg d "$DEFAULT_BRANCH" 'select(.name==$d) | .oid' "$TMP/branches.ndjson" | head -1)"
jq -r --arg p "$RELEASE_PREFIX" 'select(.name|startswith($p)) | "\(.name)\t\(.oid)"' \
  "$TMP/branches.ndjson" > "$TMP/release_raw.tsv"
# newest-first; -V (version sort) is ideal but absent on older BSD sort, so fall back.
sort -rV "$TMP/release_raw.tsv" 2>/dev/null > "$TMP/release_pairs.tsv" \
  || sort -r "$TMP/release_raw.tsv" > "$TMP/release_pairs.tsv"

USE_LOCAL_MERGE=0
if [[ -n "$LOCAL_REPO" ]] && command -v git >/dev/null \
   && git -C "$LOCAL_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  USE_LOCAL_MERGE=1
  # Sanity-check: are the enumerated tips actually in the local clone?
  present=0; sample=0
  while IFS= read -r oid; do
    sample=$((sample+1)); (( sample > 200 )) && break
    git -C "$LOCAL_REPO" cat-file -e "${oid}^{commit}" 2>/dev/null && present=$((present+1)) || true
  done < <(jq -r '.[].oid' "$TMP/stale.json")
  log ">> local merge mode: $present/$sample sampled stale tips present in $LOCAL_REPO"
  if (( sample > 0 && present * 100 / sample < 80 )); then
    log "   WARNING: many tips missing locally - run 'git -C $LOCAL_REPO fetch --all --prune' first,"
    log "            or branches will be reported as unmerged. Falling back to API for missing tips."
  fi
else
  log ">> LOCAL_REPO not usable; merge checks will use the (slow, rate-limited) compare API."
fi

have_obj()         { git -C "$LOCAL_REPO" cat-file -e "${1}^{commit}" 2>/dev/null; }
is_ancestor_local(){ git -C "$LOCAL_REPO" merge-base --is-ancestor "$1" "$2" 2>/dev/null; }

# API compare helper (fallback): is $head fully contained in $base? (ahead_by == 0)
is_contained_in() {
  local base="$1" head="$2" resp ahead
  resp="$(rest_soft "/repos/$OWNER/$REPO/compare/${base}...${head}")"
  ahead="$(jq -r '.ahead_by // empty' <<<"$resp")"
  [[ -z "$ahead" ]] && return 1
  [[ "$ahead" == "0" ]]
}

# Returns the ref a branch is merged into (release first, then default), or "".
merge_target() {
  local sname="$1" soid="$2" target="" checked=0 roid rname
  if (( USE_LOCAL_MERGE == 1 )) && have_obj "$soid"; then
    while IFS=$'\t' read -r rname roid; do
      (( MAX_RELEASE_CHK > 0 && checked >= MAX_RELEASE_CHK )) && break
      checked=$((checked+1))
      have_obj "$roid" || continue
      is_ancestor_local "$soid" "$roid" && { target="$rname"; break; }
    done < "$TMP/release_pairs.tsv"
    if [[ -z "$target" && -n "$DEFAULT_OID" ]] && have_obj "$DEFAULT_OID"; then
      is_ancestor_local "$soid" "$DEFAULT_OID" && target="$DEFAULT_BRANCH"
    fi
  else
    while IFS=$'\t' read -r rname roid; do
      (( MAX_RELEASE_CHK > 0 && checked >= MAX_RELEASE_CHK )) && break
      checked=$((checked+1))
      is_contained_in "$rname" "$sname" && { target="$rname"; break; }
    done < "$TMP/release_pairs.tsv"
    [[ -z "$target" ]] && is_contained_in "$DEFAULT_BRANCH" "$sname" && target="$DEFAULT_BRANCH"
  fi
  echo "$target"
}

# CSV export header
CSV="$WORKDIR/stale-branches-${REPO}.csv"
echo "branch,last_commit_date,age_days,merged_into,safe_to_delete" > "$CSV"

if (( STALE_COUNT > 0 )); then
  printf "\n%-45s %-12s %-22s %s\n" "BRANCH" "AGE(days)" "LAST COMMIT" "MERGED INTO"
  i=0
  while IFS=$'\t' read -r name date age oid; do
    i=$((i+1))
    (( i % 50 == 0 )) && log "   ...processed $i/$STALE_COUNT branches"
    merged_into="$(merge_target "$name" "$oid")"
    if [[ -n "$merged_into" ]]; then
      printf "%-45s %-12s %-22s \033[32m%s\033[0m\n" "$name" "$age" "${date:0:10}" "$merged_into"
      echo "\"$name\",${date:0:10},$age,$merged_into,YES" >> "$CSV"
    else
      printf "%-45s %-12s %-22s \033[33m%s\033[0m\n" "$name" "$age" "${date:0:10}" "(unmerged - review)"
      echo "\"$name\",${date:0:10},$age,,REVIEW" >> "$CSV"
    fi
  done < <(jq -r '.[] | [.name,.date,.age_days,.oid] | @tsv' "$TMP/stale.json")

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
  printf "%12s  %s\n" "$(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B")" "$path"
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
  printf "%12s  %8s  %s\n" "$(numfmt --to=iec "$total" 2>/dev/null || echo "${total}B")" "$count" "$ext"
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

# ----------------------------- optional: history ------------------------------
# Surfaces the largest objects across ALL history (what actually determines .git
# size) - the API's blind spot. Uses an existing clone if LOCAL_REPO is set,
# otherwise falls back to a shallow-blob bare clone. Set RUN_HISTORY=1 (or in
# .env) to run it automatically; or call analyze_history_locally yourself.
analyze_history_locally() {
  command -v git >/dev/null || { log "git not found; skipping history analysis"; return 1; }

  local gitdir cleanup=""
  if [[ -n "$LOCAL_REPO" ]]; then
    if [[ ! -d "$LOCAL_REPO" ]]; then
      log "LOCAL_REPO '$LOCAL_REPO' does not exist; skipping history analysis"; return 1
    fi
    # Validate it's actually a git repo (works for both worktrees and bare clones).
    if ! git -C "$LOCAL_REPO" rev-parse --git-dir >/dev/null 2>&1; then
      log "LOCAL_REPO '$LOCAL_REPO' is not a git repo; skipping"; return 1
    fi
    gitdir="$LOCAL_REPO"
    log ">> analyzing existing clone at $gitdir"
    log "   (note: only reflects refs present locally - run 'git fetch --all' first for full coverage)"
  else
    gitdir="$TMP/clone"
    log ">> no LOCAL_REPO set; bare-cloning for history analysis (this may take a while)..."
    git clone --bare --filter=blob:none "https://github.com/$OWNER/$REPO.git" "$gitdir" 2>/dev/null \
      || { log "clone failed"; return 1; }
  fi

  bar; echo "HISTORY: largest objects across ALL refs"; bar
  git -C "$gitdir" rev-list --objects --all \
    | git -C "$gitdir" cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
    | awk '/^blob/ {print $3, $4}' \
    | sort -rn | head -n "$TOP_FILES" \
    | while read -r sz path; do
        printf "%12s  %s\n" "$(numfmt --to=iec "$sz" 2>/dev/null || echo "${sz}B")" "${path:-(unreferenced)}"
      done

  # Bonus: on-disk .git size for the local clone.
  if [[ -n "$LOCAL_REPO" ]]; then
    echo
    echo "On-disk size of $gitdir:"
    du -sh "$gitdir" 2>/dev/null | awk '{print "  " $1}'
  fi
}

# Run automatically when RUN_HISTORY=1 (set in .env or env). Otherwise call manually.
if [[ "${RUN_HISTORY:-0}" == "1" ]]; then
  analyze_history_locally
fi

bar; echo "Done."; bar