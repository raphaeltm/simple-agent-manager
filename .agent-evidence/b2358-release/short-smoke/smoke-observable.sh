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
  python3 - "$evidence" "$result" "$mode" "$current_step" <<'PYRECEIPT'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); code=int(sys.argv[2]); mode=sys.argv[3]
labels='helper helper30 foreign foreignEmpty git gh validate clone branch before commit after treeUnchanged push'.split()
statuses={k:int(p.joinpath(k+'.exit').read_text()) if p.joinpath(k+'.exit').exists() else None for k in labels}
ok=lambda k:statuses[k]==0
checks={'helperTimeout30':ok('helper30'),'helperConfigured':ok('helper') and ok('validate'),'foreignHostDenied':ok('foreign') and ok('foreignEmpty'),'privateGitAccess':ok('git') and ok('validate'),'privateGhAccess':ok('gh') and ok('validate'),'privateClone':ok('clone'),'testCommitTreeUnchanged':ok('treeUnchanged'),'explicitPush':ok('push')}
report={'mode':mode,'probeCompleted':code==0 and all(checks.values()),'failingStep':None if code==0 else sys.argv[4],'checks':checks,'statuses':statuses}
p.joinpath('original-probe.json').write_text(json.dumps(report,sort_keys=True)+'\n')
p.joinpath('exit.json').write_text(json.dumps({'exitCode':code,'mode':mode})+'\n')
PYRECEIPT
  printf '%s\n' "$evidence"
}
trap finish EXIT
trap 'exit 124' TERM INT
run() {
  label=$1; current_step=$label; shift
  setsid timeout --signal=TERM --kill-after=2s 30s "$@" >"$evidence/$label.out" 2>"$evidence/$label.err" &
  active=$!
  wait "$active"; rc=$?
  kill -KILL -- "-$active" 2>/dev/null || :
  wait "$active" 2>/dev/null || :
  active=''
  printf '%s' "$rc" >"$evidence/$label.exit"
  return "$rc"
}
run helper git config --get credential.helper || exit 1
run helper30 python3 -c 'import pathlib,re; p=pathlib.Path("/usr/local/bin/git-credential-sam"); assert re.search(rb"(?m)^\s*curl\b[^\n]*--max-time\s+[\x22\x27]?30(?:\s|[\x22\x27])",p.read_bytes())' || exit 1
printf 'protocol=https\nhost=example.invalid\npath=owner/repo\n\n' >"$evidence/request"
run foreign /usr/local/bin/git-credential-sam get <"$evidence/request" || exit 1
run foreignEmpty test ! -s "$evidence/foreign.out" || exit 1
run git git ls-remote --heads origin || exit 1
run gh gh repo view serverspresentation2025/crewai --json isPrivate || exit 1
run validate python3 -c 'import pathlib,json,re,sys; p=pathlib.Path(sys.argv[1]); assert p.joinpath("helper.out").read_text().strip()=="/usr/local/bin/git-credential-sam"; assert json.loads(p.joinpath("gh.out").read_text())["isPrivate"] is True; lines=p.joinpath("git.out").read_bytes().splitlines(); assert lines and all(re.fullmatch(rb"[0-9a-f]{40,64}\trefs/heads/[^\s]+",x) for x in lines)' "$evidence" || exit 1
run clone git clone --depth 1 --filter=blob:none https://github.com/serverspresentation2025/crewai.git "$evidence/clone" || exit 1
cd "$evidence/clone" || exit 1
run branch git switch -c "$branch" || exit 1
run before git rev-parse 'HEAD^{tree}' || exit 1
run commit git -c user.name='SAM disposable probe' -c user.email=probe@example.invalid commit --allow-empty -m 'test: explicit disposable B fixture' || exit 1
run after git rev-parse 'HEAD^{tree}' || exit 1
run treeUnchanged cmp -s "$evidence/before.out" "$evidence/after.out" || exit 1
run push git push origin "HEAD:refs/heads/$branch" || exit 1
exit 0
