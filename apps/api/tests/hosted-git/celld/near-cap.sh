#!/usr/bin/env bash
cd /tmp/celld-run && rm -rf n && mkdir n && cd n
export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e
G() { git -c gc.auto=0 "$@"; }
R=http://127.0.0.1:9876/repo/nearcap.git
curl -s -X PUT -d '{"defaultBranch":"main"}' $R/init >/dev/null
G init -q -b main src && cd src
for d in $(seq 0 99); do mkdir d$d; for i in $(seq 0 279); do echo "$d $i $RANDOM" > d$d/f$i; done; done
G add . && G commit -qm bulk
echo "objects: $(G count-objects -v | awk '/count|in-pack/{s+=$2} END{print s}')"
s=$(date +%s%N); G push -q $R main 2>/dev/null; echo "push rc=$? $(( ($(date +%s%N)-s)/1000000 )) ms"
cd ..; s=$(date +%s%N); G clone -q $R cold; echo "cold clone rc=$? $(( ($(date +%s%N)-s)/1000000 )) ms"
s=$(date +%s%N); G clone -q $R warm; echo "warm clone rc=$? $(( ($(date +%s%N)-s)/1000000 )) ms"
s=$(date +%s%N); G clone -q --depth 1 $R shallow; echo "shallow clone rc=$? $(( ($(date +%s%N)-s)/1000000 )) ms"
G -C cold fsck --strict && echo fsck ok
