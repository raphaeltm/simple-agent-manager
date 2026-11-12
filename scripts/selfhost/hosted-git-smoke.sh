#!/usr/bin/env bash
# Smoke test for SAM-hosted repositories on a self-hosted box.
#
#   SAM_DOMAIN=vmtest.sam2.party SAM_API_TOKEN=sam_... scripts/selfhost/hosted-git-smoke.sh
#
# Inputs (environment):
#   SAM_DOMAIN       the box's SAM_DOMAIN (api.<SAM_DOMAIN> must answer)
#   SAM_API_TOKEN    an API token of an email-only account (Settings -> API tokens), exchanged
#                    for a session cookie via POST /api/auth/token-login. Never printed.
#   SAM_INSECURE=1   optional: skip TLS verification (SAM_TLS_MODE=internal boxes)
#   SMOKE_IMPORT_URL optional: also create a project imported from this public repository
#                    (github.com, gitlab.com, codeberg.org or bitbucket.org), then clone it
#   SMOKE_RUN_TASK=1 optional: also submit an agent task that commits and pushes a branch from
#                    a workspace, then wait for that branch (SMOKE_TASK_TIMEOUT_S, default 1200)
#
# Steps: capability on -> create an artifacts project -> member token -> clone (README) ->
# push a branch -> fresh clone sees it -> unauthenticated clone refused -> (optional) workspace
# task pushes a branch. Exits non-zero on the first failure.
set -euo pipefail

: "${SAM_DOMAIN:?set SAM_DOMAIN}"
: "${SAM_API_TOKEN:?set SAM_API_TOKEN}"
API="https://api.${SAM_DOMAIN}"
WORK="$(mktemp -d)"
JAR="${WORK}/cookies"
trap 'rm -rf "$WORK"' EXIT

CURL=(curl -fsS --max-time 60 -b "$JAR" -c "$JAR")
GIT=(git -c credential.helper= -c gc.auto=0)
if [[ "${SAM_INSECURE:-}" == "1" ]]; then
  CURL+=(-k)
  GIT+=(-c http.sslVerify=false)
fi
export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.com \
  GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.com

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
# A remote URL with the token as the Basic password (never echoed).
authed() { python3 -c "import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit((p.scheme,'x:'+u.quote(sys.argv[2],safe='')+'@'+p.netloc,p.path,'','')))" "$1" "$2"; }

step "sign in with the API token"
# The token goes through stdin so it never appears in the process list.
python3 -c 'import json,os; print(json.dumps({"token": os.environ["SAM_API_TOKEN"]}))' |
  "${CURL[@]}" -X POST -H 'content-type: application/json' --data @- \
    "${API}/api/auth/token-login" >/dev/null

step "SAM-native repositories are enabled"
enabled="$("${CURL[@]}" "${API}/api/config/artifacts-enabled" | json "['enabled']")"
[[ "$enabled" == "True" ]] || fail "artifacts-enabled is $enabled (redeploy with this branch)"

step "create a project with a SAM-hosted repository"
name="hosted-smoke-$(date +%s)"
project="$("${CURL[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"name\":\"${name}\",\"repoProvider\":\"artifacts\",\"description\":\"hosted git smoke\"}" \
  "${API}/api/projects")"
project_id="$(json "['id']" <<<"$project")"
remote="$(json "['repository']" <<<"$project")"
echo "project ${project_id} remote ${remote}"
[[ "$remote" == "${API}/git/"* ]] || fail "unexpected remote ${remote}"

step "member write token, clone, README present"
token="$("${CURL[@]}" -X POST "${API}/api/projects/${project_id}/hosted-git/token?scope=write" | json "['token']")"
"${GIT[@]}" clone -q "$(authed "$remote" "$token")" "${WORK}/clone"
grep -q "$name" "${WORK}/clone/README.md" || fail "seeded README missing"

step "push a branch"
(cd "${WORK}/clone" && git checkout -q -b smoke/human && echo "pushed $(date -u)" >smoke.txt &&
  git add smoke.txt && git commit -qm "smoke push" && "${GIT[@]}" push -q origin smoke/human)

step "fresh clone sees the branch"
"${GIT[@]}" clone -q --branch smoke/human "$(authed "$remote" "$token")" "${WORK}/verify"
[[ -f "${WORK}/verify/smoke.txt" ]] || fail "pushed file missing"

step "unauthenticated clone is refused"
if "${GIT[@]}" clone -q "$remote" "${WORK}/anon" 2>/dev/null; then fail "anonymous clone succeeded"; fi
echo "refused as expected"

if [[ -n "${SMOKE_IMPORT_URL:-}" ]]; then
  step "import ${SMOKE_IMPORT_URL}"
  imported="$(python3 -c 'import json,os,sys; print(json.dumps({"name": sys.argv[1], "repoProvider": "artifacts", "importUrl": os.environ["SMOKE_IMPORT_URL"]}))' "${name}-import" |
    "${CURL[@]}" -X POST -H 'content-type: application/json' --data @- "${API}/api/projects")"
  imported_id="$(json "['id']" <<<"$imported")"
  imported_remote="$(json "['repository']" <<<"$imported")"
  itoken="$("${CURL[@]}" -X POST "${API}/api/projects/${imported_id}/hosted-git/token" | json "['token']")"
  "${GIT[@]}" clone -q "$(authed "$imported_remote" "$itoken")" "${WORK}/imported"
  echo "imported HEAD $(git -C "${WORK}/imported" log -1 --format='%h %s')"
fi

if [[ "${SMOKE_RUN_TASK:-}" == "1" ]]; then
  step "workspace task clones and pushes (provisions a node; minutes)"
  "${CURL[@]}" -X POST -H 'content-type: application/json' \
    -d '{"message":"Create a file named agent-smoke.txt containing the word hello, commit it, and run: git push origin HEAD:refs/heads/smoke/agent . Reply done when the push succeeds."}' \
    "${API}/api/projects/${project_id}/tasks/submit" >/dev/null
  deadline=$(( $(date +%s) + ${SMOKE_TASK_TIMEOUT_S:-1200} ))
  until "${GIT[@]}" ls-remote "$(authed "$remote" "$token")" refs/heads/smoke/agent | grep -q smoke/agent; do
    (( $(date +%s) < deadline )) || fail "workspace never pushed smoke/agent (check the task in the UI)"
    sleep 20
  done
  echo "workspace pushed smoke/agent"
fi

printf '\nPASS: SAM-hosted repository smoke (project %s)\n' "$project_id"
