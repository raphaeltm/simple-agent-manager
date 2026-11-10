#!/usr/bin/env bash
# Start three local S3-compatible stores for the celld storage qualification test.
# Throwaway credentials only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
docker rm -f spike-minio spike-garage spike-seaweed >/dev/null 2>&1 || true
docker run -d --name spike-minio -p 127.0.0.1:9000:9000 \
  -e MINIO_ROOT_USER=spikeadmin -e MINIO_ROOT_PASSWORD=spikeadmin-throwaway \
  -v spike-minio:/data pgsty/minio:latest server /data >/dev/null
docker run -d --name spike-garage -p 127.0.0.1:3900:3900 -p 127.0.0.1:3903:3903 \
  -v "$HERE/config/garage.toml:/etc/garage.toml:ro" -v spike-garage:/var/lib/garage \
  dxflrs/garage:v2.5.0 >/dev/null
docker run -d --name spike-seaweed -p 127.0.0.1:8333:8333 \
  -v spike-seaweed:/data chrislusf/seaweedfs:latest server -dir=/data -s3 -s3.port=8333 >/dev/null
echo started
