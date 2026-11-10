#!/usr/bin/env bash
# Q3: 1 GiB download/upload and small-request latency across four paths.
set -u
N=${N:-1073741824}
declare -A P=(
  [1-raw-loopback]="http://127.0.0.1:9201"                    # host backend, no Worker, no tunnel
  [2-worker-only]="http://127.0.0.1:8787/direct/9201"           # Worker -> host backend (Worker overhead)
  [3-tunnel-only]="http://127.0.0.1:17002"                      # frps -> frpc -> node backend (tunnel overhead)
  [4-worker+tunnel]="http://127.0.0.1:8787/tcp/node-b"          # Worker -> frps -> frpc -> node backend (proposed path)
)
for k in $(printf '%s\n' "${!P[@]}" | sort); do
  b=${P[$k]}
  dl=$(curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_total} %{speed_download}' "$b/bytes?n=$N")
  ul=$(head -c "$N" /dev/zero | curl -s -X POST -H 'Content-Type: application/octet-stream' -T - -w ' %{http_code} %{time_total}' "$b/sink")
  lat=$(for i in $(seq 1 200); do curl -s -o /dev/null -w '%{time_total}\n' "$b/health"; done | sort -n | awk '{a[NR]=$1} END {printf "p50=%.1fms p95=%.1fms p99=%.1fms", a[int(NR*0.5)]*1000, a[int(NR*0.95)]*1000, a[int(NR*0.99)]*1000}')
  echo "$k"
  echo "  download: $dl" | awk '{printf "  download 1 GiB: http=%s bytes=%s time=%.2fs rate=%.0f MiB/s\n", $2, $3, $4, $5/1048576}'
  echo "  upload (chunked, duplex half): $ul"
  echo "  /health latency x200: $lat"
done
