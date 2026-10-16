#!/usr/bin/env bash
# Invoke once with: timeout --signal=TERM --kill-after=2s 180s bash smoke.sh MODE BRANCH
set -u
export GIT_TERMINAL_PROMPT=0
umask 077
mode=$1
branch=$2
case "$mode" in devcontainer|standalone) ;; *) exit 2;; esac
case "$branch" in sam/reliability-b-*) ;; *) exit 2;; esac
evidence=$(mktemp -d /tmp/b2358-smoke.XXXXXX)
active=''
current_step=setup
cleanup() { if [ -n "$active" ]; then kill -KILL -- "-$active" 2>/dev/null || :; wait "$active" 2>/dev/null || :; fi; }
finish() {
  result=$?
  cleanup
  node - "$evidence" "$result" "$mode" "$current_step" <<'JSRECEIPT'
const fs=require('node:fs'), path=require('node:path');
const [p,rawCode,mode,step]=process.argv.slice(2),code=Number(rawCode);
const labels='helper helper30 foreign foreignEmpty git gh validate clone branch before commit after treeUnchanged push'.split(' ');
const statuses=Object.fromEntries(labels.map(k=>{const f=path.join(p,k+'.exit');return [k,fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):null]}));
const ok=k=>statuses[k]===0;
const checks={helperTimeout30:ok('helper30'),helperConfigured:ok('helper')&&ok('validate'),foreignHostDenied:ok('foreign')&&ok('foreignEmpty'),privateGitAccess:ok('git')&&ok('validate'),privateGhAccess:ok('gh')&&ok('validate'),privateClone:ok('clone'),testCommitTreeUnchanged:ok('treeUnchanged'),explicitPush:ok('push')};
fs.writeFileSync(path.join(p,'original-probe.json'),JSON.stringify({mode,probeCompleted:code===0&&Object.values(checks).every(Boolean),failingStep:code===0?null:step,checks,statuses})+'\n');
fs.writeFileSync(path.join(p,'exit.json'),JSON.stringify({exitCode:code,mode})+'\n');
JSRECEIPT
  printf '%s\n' "$evidence"
}
trap finish EXIT
trap 'exit 124' TERM INT
run() {
  label=$1; current_step=$label; shift
  exec 3<&0
  setsid timeout --signal=TERM --kill-after=2s 30s "$@" <&3 >"$evidence/$label.out" 2>"$evidence/$label.err" &
  active=$!
  exec 3<&-
  wait "$active"; rc=$?
  kill -KILL -- "-$active" 2>/dev/null || :
  wait "$active" 2>/dev/null || :
  active=''
  printf '%s' "$rc" >"$evidence/$label.exit"
  return "$rc"
}
run helper git config --get credential.helper || exit 1
run helper30 node -e 'const fs=require("node:fs"),assert=require("node:assert");assert(/^[ \t]*curl\b[^\n]*--max-time\s+["\x27]?30(?:\s|["\x27])/m.test(fs.readFileSync("/usr/local/bin/git-credential-sam","utf8")))' || exit 1
printf 'protocol=https\nhost=example.invalid\npath=owner/repo\n\n' >"$evidence/request"
run foreign /usr/local/bin/git-credential-sam get <"$evidence/request" || exit 1
run foreignEmpty test ! -s "$evidence/foreign.out" || exit 1
run git git ls-remote --heads origin || exit 1
run gh gh repo view serverspresentation2025/crewai --json isPrivate || exit 1
run validate node -e 'const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert"),p=process.argv[1],read=n=>fs.readFileSync(path.join(p,n),"utf8");assert.strictEqual(read("helper.out").trim(),"/usr/local/bin/git-credential-sam");assert.strictEqual(JSON.parse(read("gh.out")).isPrivate,true);const lines=read("git.out").trimEnd().split("\n");assert(lines.length&&lines.every(x=>/^[0-9a-f]{40,64}\trefs\/heads\/[^\s]+$/.test(x)))' "$evidence" || exit 1
run clone git clone --depth 1 --filter=blob:none https://github.com/serverspresentation2025/crewai.git "$evidence/clone" || exit 1
cd "$evidence/clone" || exit 1
run branch git switch -c "$branch" || exit 1
run before git rev-parse 'HEAD^{tree}' || exit 1
run commit git -c user.name='SAM disposable probe' -c user.email=probe@example.invalid commit --allow-empty -m 'test: explicit disposable B fixture' || exit 1
run after git rev-parse 'HEAD^{tree}' || exit 1
run treeUnchanged cmp -s "$evidence/before.out" "$evidence/after.out" || exit 1
run push git push origin "HEAD:refs/heads/$branch" || exit 1
exit 0
