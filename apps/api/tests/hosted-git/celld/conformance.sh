#!/usr/bin/env bash
set -u
cd /tmp/celld-run && rm -rf w && mkdir w && cd w
export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e
G() { git -c gc.auto=0 -c protocol.version=2 "$@"; }
R=http://127.0.0.1:9876/repo/demo2.git
t() { local s=$(date +%s%N); "$@"; local rc=$?; echo "  rc=$rc $(( ($(date +%s%N)-s)/1000000 )) ms: $*"; }
curl -s -X PUT -d '{"defaultBranch":"main"}' $R/init; echo
G init -q -b main src && cd src && for i in $(seq 1 50); do echo "line $i" > f$i.txt; done && G add . && G commit -qm one && for c in 2 3 4; do echo $c >> f1.txt; G commit -qam c$c; done
t G push -q $R main
cd ..; t G clone -q $R full; G -C full fsck --strict && echo "  fsck ok, commits=$(G -C full rev-list --count HEAD)"
t G clone -q --depth 1 $R shallow; echo "  shallow commits: $(G -C shallow rev-list --count HEAD)"
cd src && echo more >> f2.txt && G commit -qam c5 && t G push -q $R main && cd ..
t G -C shallow fetch -q origin main; echo "  fetched $(G -C shallow rev-parse --short FETCH_HEAD) vs $(G -C src rev-parse --short HEAD)"
cd src && G checkout -qb gone && echo x > gone.txt && G add . && G commit -qm gone && t G push -q $R gone && t G push -q $R --delete gone && cd ..
echo "== push over the size cap (65 MiB random)"
cd src && G checkout -q main && head -c $((65*1024*1024)) /dev/urandom > big.bin && G add big.bin && G commit -qm big && t G push $R main:refs/heads/big 2>&1 | grep -E "remote:|error|rejected" | head -4; G reset -q --hard HEAD~1; cd ..
echo "== push over the object cap"
cd src && mkdir many && for i in $(seq 0 30000); do echo $i > many/f$i; done && G add many && G commit -qm many && t G push $R main:refs/heads/many 2>&1 | grep -E "remote:|error|rejected" | head -4; cd ..
echo "== repo still serves after refusals"; t G clone -q $R after; G -C after fsck --strict && echo "  fsck ok"
