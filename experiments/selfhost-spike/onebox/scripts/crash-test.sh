#!/usr/bin/env bash
# kill -9 celld mid-load, restart it, then verify every acknowledged write survived.
# usage: crash-test.sh <minio|seaweedfs> [RESTART_DELAY_S]
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; STORE=$1; DELAY=${2:-0}
T=/workspaces/simple-agent-manager/.tmp/run; B=http://127.0.0.1:8080; DATA=$T/node-$STORE
node "$HERE/tools/load.mjs" $B do 40 8 $T/crash-do.ack 4 > $T/crash-do.out &
L1=$!
node "$HERE/tools/load.mjs" $B d1 40 4 $T/crash-d1.ack > $T/crash-d1.out &
L2=$!
sleep 12
echo "kill -9 at $(date +%T.%3N), acked so far: do=$(wc -l < $T/crash-do.ack) d1=$(wc -l < $T/crash-d1.ack)"
OLD=$(cat $DATA.pid); kill -9 "$OLD"; KILLED=$(date +%s%3N)
while kill -0 "$OLD" 2>/dev/null; do sleep 0.05; done   # supervisor sees the exit
sleep "$DELAY"
# Supervisor-style restart: retry until the process stays up (port may still be held briefly).
for try in $(seq 1 30); do
  "$HERE/scripts/run-node.sh" "$STORE" "$DATA" "$T/node-$STORE.restart.log" >/dev/null; STARTED=$(date +%s%3N)
  sleep 1; kill -0 "$(cat $DATA.pid)" 2>/dev/null && break; echo "restart attempt $try exited: $(tail -1 $T/node-$STORE.restart.log)"
done
DL=$(( $(date +%s) + 300 ))
until curl -sf -o /dev/null $B/healthz; do sleep 0.1; [ $(date +%s) -gt $DL ] && { echo "TIMEOUT healthz"; break; }; done; H=$(date +%s%3N)
until curl -sf -o /dev/null -m 20 "$B/do/write?name=load0&k=probe-$H"; do sleep 0.1; [ $(date +%s) -gt $DL ] && { echo "TIMEOUT write"; break; }; done; W=$(date +%s%3N)
echo "restart: process start->healthz $((H-STARTED)) ms; ->first DO write $((W-STARTED)) ms; kill->first DO write $((W-KILLED)) ms"
wait $L1 $L2
echo "load do: $(cat $T/crash-do.out)"; echo "load d1: $(cat $T/crash-d1.out)"
missing=0
for n in 0 1 2 3; do
  curl -s "$B/do/keys?name=load$n" | jq -r '.keys[]' | sort > $T/have-do-$n
  grep "^load$n " $T/crash-do.ack | awk '{print $2}' | sort > $T/want-do-$n
  m=$(comm -23 $T/want-do-$n $T/have-do-$n | wc -l); missing=$((missing+m))
  echo "DO load$n: acked=$(wc -l < $T/want-do-$n) present=$(wc -l < $T/have-do-$n) missing=$m"
done
curl -s "$B/d1/keys" | jq -r '.keys[]' | sort > $T/have-d1; awk '{print $2}' $T/crash-d1.ack | sort > $T/want-d1
m=$(comm -23 $T/want-d1 $T/have-d1 | wc -l); missing=$((missing+m))
echo "D1: acked=$(wc -l < $T/want-d1) present(all keys in table)=$(wc -l < $T/have-d1) missing=$m"
echo "TOTAL MISSING ACKED WRITES: $missing"
