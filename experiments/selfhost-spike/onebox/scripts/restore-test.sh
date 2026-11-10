#!/usr/bin/env bash
# Restore a backup's bucket into a fresh MinIO and boot a node with an EMPTY data dir
# (bucket-only restore) on 127.0.0.1:8081, then print the state fingerprint.
# usage: restore-test.sh BACKUP_DIR [CELLD_BINARY]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; BK=$1; BIN=${2:-/workspaces/simple-agent-manager/.tmp/celld-dl/v0.6.2/celld}
T=/workspaces/simple-agent-manager/.tmp/run; DATA=$T/node-restore; rm -rf $DATA; mkdir -p $DATA
docker rm -f spike-minio-r >/dev/null 2>&1 || true
docker run -d --name spike-minio-r -p 127.0.0.1:9100:9000 -e MINIO_ROOT_USER=spikeadmin -e MINIO_ROOT_PASSWORD=spikeadmin-throwaway \
  -v "$BK/bucket:/restore/celld-fleet:ro" pgsty/minio:latest server /data >/dev/null
until docker exec spike-minio-r sh -c 'mc alias set l http://127.0.0.1:9000 spikeadmin spikeadmin-throwaway' >/dev/null 2>&1; do sleep 1; done
S=$(date +%s); docker exec spike-minio-r sh -c 'mc mb -q l/celld-fleet >/dev/null && mc mirror --quiet /restore/celld-fleet l/celld-fleet >/dev/null'
echo "restored bucket in $(( $(date +%s)-S )) s"
S=$(date +%s)
CELLD_WATCH=$DATA CELLD_ADDR=127.0.0.1:8081 CELLD_INTERNAL_ADDR=127.0.0.1:7002 S3_ENDPOINT=http://127.0.0.1:9100 \
  AWS_ACCESS_KEY_ID=spikeadmin AWS_SECRET_ACCESS_KEY=spikeadmin-throwaway AWS_REGION=us-east-1 \
  nohup "$BIN" --bucket s3://celld-fleet > $T/node-restore.log 2>&1 & echo $! > $DATA.pid
until curl -sf -o /dev/null -m 30 "http://127.0.0.1:8081/do/keys?name=load0"; do sleep 0.5; done
echo "restored node serving after $(( $(date +%s)-S )) s"
"$HERE/scripts/state.sh" http://127.0.0.1:8081
