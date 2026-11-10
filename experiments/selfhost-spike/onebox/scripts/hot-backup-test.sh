#!/usr/bin/env bash
# Mirror the bucket WHILE celld takes writes, restore that mirror, and check every write
# acknowledged before the mirror started is present and the node boots.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; T=/workspaces/simple-agent-manager/.tmp/run; BK=/workspaces/simple-agent-manager/.tmp/backup-hot; rm -rf $BK; mkdir -p $BK
node "$HERE/tools/load.mjs" http://127.0.0.1:8080 do 90 4 $T/hot-do.ack 4 > $T/hot-do.out &
node "$HERE/tools/load.mjs" http://127.0.0.1:8080 d1 90 2 $T/hot-d1.ack > $T/hot-d1.out &
sleep 10; cp $T/hot-do.ack $T/hot-do.premirror; cp $T/hot-d1.ack $T/hot-d1.premirror
echo "mirror start; acked before start: do=$(wc -l < $T/hot-do.premirror) d1=$(wc -l < $T/hot-d1.premirror)"
S=$(date +%s); docker exec spike-minio sh -c 'rm -rf /tmp/bk && mc alias set l http://127.0.0.1:9000 spikeadmin spikeadmin-throwaway >/dev/null && mc mirror --quiet l/celld-fleet /tmp/bk/celld-fleet >/dev/null 2>&1; echo mirror-exit=$?'
docker cp -q spike-minio:/tmp/bk/celld-fleet $BK/bucket; docker exec spike-minio rm -rf /tmp/bk; echo "hot mirror took $(( $(date +%s)-S )) s"
wait
"$HERE/scripts/restore-test.sh" $BK > $T/hot-restore.out 2>&1; cat $T/hot-restore.out | head -3
missing=0
for n in 0 1 2 3; do
  curl -s "http://127.0.0.1:8081/do/keys?name=load$n" | jq -r '.keys[]' | sort > $T/hr-have
  grep "^load$n " $T/hot-do.premirror | awk '{print $2}' | sort > $T/hr-want
  m=$(comm -23 $T/hr-want $T/hr-have | wc -l); missing=$((missing+m)); echo "DO load$n: acked-before-mirror=$(wc -l < $T/hr-want) missing=$m present=$(wc -l < $T/hr-have)"
done
curl -s http://127.0.0.1:8081/d1/keys | jq -r '.keys[]' | sort > $T/hr-have; awk '{print $2}' $T/hot-d1.premirror | sort > $T/hr-want
m=$(comm -23 $T/hr-want $T/hr-have | wc -l); missing=$((missing+m)); echo "D1: acked-before-mirror=$(wc -l < $T/hr-want) missing=$m"
echo "HOT BACKUP MISSING PRE-MIRROR WRITES: $missing"
