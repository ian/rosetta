#!/usr/bin/env bash
# Runner for the Rosetta GitHub Action (action.yml). Also runnable locally for
# testing: set INPUT_* env vars, and ROSETTA_BIN to override the rosetta command.
set -euo pipefail

MODE="${INPUT_MODE:-pull-request}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

log() { echo "[rosetta] $*" >&2; }
fail() { echo "::error::$*" >&2; exit "${2:-1}"; }
out() { echo "$1=$2" >>"$OUTPUT"; }

out changed false
out pr-url ""
out commit-sha ""

case "$MODE" in
  pull-request | commit | check) ;;
  *) fail "Unknown mode \"$MODE\" (expected pull-request, commit, or check)." 2 ;;
esac

# --- Resolve the rosetta command ---------------------------------------------
if [ -n "${ROSETTA_BIN:-}" ]; then
  read -r -a ROSETTA <<<"$ROSETTA_BIN"
elif [ -z "${INPUT_VERSION:-}" ] && [ -x node_modules/.bin/rosetta ]; then
  ROSETTA=(node_modules/.bin/rosetta)
else
  version="${INPUT_VERSION:-}"
  if [ -z "$version" ]; then
    # ian/rosetta@v1.2.3 (or @v1.0.0-beta.1) → that exact version; @v1 → latest 1.x.
    if [[ "${ACTION_REF:-}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+.*)$ ]]; then
      version="${BASH_REMATCH[1]}"
    elif [[ "${ACTION_REF:-}" =~ ^v([0-9]+) ]]; then
      version="${BASH_REMATCH[1]}"
    else
      version="latest"
    fi
  fi
  if [[ "$version" == */* || "$version" == *.tgz || "$version" == file:* ]]; then
    spec="$version"
  else
    spec="rosetta-i18n@$version"
  fi
  ROSETTA=(npx --yes --package "$spec" rosetta)
fi
log "using: ${ROSETTA[*]}"

# --- check mode ---------------------------------------------------------------
if [ "$MODE" = "check" ]; then
  exec "${ROSETTA[@]}" check
fi

# --- push ---------------------------------------------------------------------
read -r -a EXTRA <<<"${INPUT_ARGS:-}"
RESULT="$TMP/rosetta-push-$$.json"
set +e
"${ROSETTA[@]}" push --json ${EXTRA[@]+"${EXTRA[@]}"} >"$RESULT"
code=$?
set -e

if [ "$code" -ge 2 ]; then
  cat "$RESULT" >&2
  fail "rosetta push failed (exit $code). See the error above." "$code"
fi

node "$HERE/summary.mjs" markdown "$RESULT" | tee -a "$SUMMARY" >&2

FILES=()
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] && [ -e "$file" ] && FILES+=("$file")
done < <(node "$HERE/summary.mjs" files "$RESULT")

has_changes=false
if [ "${#FILES[@]}" -gt 0 ] && [ -n "$(git status --porcelain -- "${FILES[@]}")" ]; then
  has_changes=true
fi

if [ "$has_changes" = false ]; then
  log "no translation changes"
  exit "$code"
fi
out changed true

# --- git identity + auth --------------------------------------------------------
git config user.name >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

host="${GITHUB_SERVER_URL:-https://github.com}"
host="${host#https://}"
origin="$(git remote get-url origin 2>/dev/null || true)"
if [ -n "${INPUT_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [[ "$origin" == *"$host"* ]]; then
  # Push with the given token (not checkout's persisted GITHUB_TOKEN header) so
  # an App token / PAT can trigger downstream workflows.
  git config --local --unset-all "http.https://$host/.extraheader" 2>/dev/null || true
  git remote set-url origin "https://x-access-token:${INPUT_TOKEN}@${host}/${GITHUB_REPOSITORY}.git"
fi
export GH_TOKEN="${INPUT_TOKEN:-${GH_TOKEN:-}}"

current_branch() {
  git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-}}"
}

MESSAGE="${INPUT_COMMIT_MESSAGE:-chore(i18n): update translations}"

# --- commit mode ----------------------------------------------------------------
if [ "$MODE" = "commit" ]; then
  if ! git symbolic-ref --quiet HEAD >/dev/null; then
    fail "HEAD is detached. For pull_request workflows, check out the PR branch: actions/checkout with ref: \${{ github.head_ref }}." 2
  fi
  branch="$(current_branch)"
  git add -- "${FILES[@]}"
  git commit --quiet -m "$MESSAGE"
  for attempt in 1 2 3; do
    if git push --quiet origin "HEAD:refs/heads/$branch"; then
      out commit-sha "$(git rev-parse HEAD)"
      log "committed translations to $branch"
      exit "$code"
    fi
    log "push rejected (attempt $attempt); rebasing onto origin/$branch"
    git fetch --quiet origin "$branch"
    if ! git rebase --quiet "origin/$branch"; then
      git rebase --abort || true
      fail "Couldn't rebase translations onto origin/$branch (conflict). Re-run the workflow."
    fi
  done
  fail "Couldn't push to $branch after 3 attempts."
fi

# --- pull-request mode ------------------------------------------------------------
pr_branch="${INPUT_BRANCH:-rosetta/translations}"
base="${INPUT_BASE:-$(current_branch)}"
[ -n "$base" ] || fail "Couldn't determine the base branch; set the \`base\` input." 2
[ "$pr_branch" != "$base" ] || fail "The PR branch ($pr_branch) must differ from the base branch." 2

git checkout --quiet -B "$pr_branch"
git add -- "${FILES[@]}"
git commit --quiet -m "$MESSAGE"
git push --quiet --force origin "$pr_branch"
out commit-sha "$(git rev-parse HEAD)"

BODY="$TMP/rosetta-pr-body-$$.md"
{
  if [ -n "${INPUT_PR_BODY:-}" ]; then printf '%s\n\n' "$INPUT_PR_BODY"; fi
  node "$HERE/summary.mjs" markdown "$RESULT"
} >"$BODY"

repo_args=()
[ -n "${GITHUB_REPOSITORY:-}" ] && repo_args=(--repo "$GITHUB_REPOSITORY")

url="$(gh pr list ${repo_args[@]+"${repo_args[@]}"} --head "$pr_branch" --base "$base" --state open --json url --jq '.[0].url // ""')"
if [ -n "$url" ]; then
  gh pr edit "$url" ${repo_args[@]+"${repo_args[@]}"} --title "${INPUT_PR_TITLE:-chore(i18n): update translations}" --body-file "$BODY" >/dev/null
  log "updated $url"
else
  url="$(gh pr create ${repo_args[@]+"${repo_args[@]}"} --base "$base" --head "$pr_branch" --title "${INPUT_PR_TITLE:-chore(i18n): update translations}" --body-file "$BODY")"
  log "opened $url"
fi
out pr-url "$url"
exit "$code"
