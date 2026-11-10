#!/usr/bin/env bash
# Cold backup of the one box: stop celld (SIGTERM = graceful handoff), wait one lease
# lifetime, mirror the fleet bucket and tar the node data dir, then start celld again.
# usage: backup.sh DEST_DIR   (MinIO in container spike-minio; node via run-node.sh)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; DEST=$1; T=/workspaces/simple-agent-manager/.tmp/run; DATA=$T/node-minio
mkdir -p "$DEST"; S=$(date +%s)
PID=$(cat $DATA.pid); kill -TERM "$PID"; while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
echo "celld stopped after $(( $(date +%s)-S )) s; waiting one lease lifetime (CELLD_TTL_MS=10s)"; sleep 11
docker exec spike-minio sh -c 'rm -rf /tmp/bk && mc alias set l http://127.0.0.1:9000 spikeadmin spikeadmin-throwaway >/dev/null && mc mirror --quiet l/celld-fleet /tmp/bk/celld-fleet >/dev/null'
docker cp -q spike-minio:/tmp/bk/celld-fleet "$DEST/bucket" && docker exec spike-minio rm -rf /tmp/bk
tar -C "$(dirname $DATA)" -cf "$DEST/node-data.tar" "$(basename $DATA)"
echo "bucket $(du -sh "$DEST/bucket" | cut -f1) objects=$(find "$DEST/bucket" -type f | wc -l)  node-data.tar $(du -h "$DEST/node-data.tar" | cut -f1)"
"$HERE/scripts/run-node.sh" minio $DATA $T/node-minio.log >/dev/null
until curl -sf -o /dev/null -m 20 "http://127.0.0.1:8080/do/keys?name=load0"; do sleep 0.5; done
echo "downtime total $(( $(date +%s)-S )) s"
