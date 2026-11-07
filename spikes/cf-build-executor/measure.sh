#!/bin/sh
# SPIKE ONLY. Run inside sandbox via exec; one fixture per invocation.
set -eu
fixture="$1"
cd "/fixtures/$fixture"
if [ "$fixture" = b ] && [ "${SPIKE_HOST_NETWORK:-0}" = 1 ]; then
 export COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.host.yaml
fi
mkdir -p /measurements
prefix="/measurements/${fixture}-$(date +%s)"
# Sample cgroup and filesystem usage throughout pull/build/save.
(while :; do date +%s; awk '/^MemTotal:|^MemFree:|^MemAvailable:/{print}' /proc/meminfo; df -B1 /var/lib/docker | tail -1; sleep 1; done) > "$prefix.usage" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true' EXIT
for base in $(docker compose config --format json | python3 -c 'import sys,json,pathlib;d=json.load(sys.stdin);print(" ".join(dict.fromkeys(pathlib.Path(s["build"]["context"],"Dockerfile").read_text().splitlines()[0].split()[1] for s in d["services"].values())))'); do
 /usr/bin/time -v docker pull "$base"
done
/usr/bin/time -v docker compose --progress plain build
images=$(docker compose config --images)
/usr/bin/time -v docker save -o "$prefix.tar" $images
stat -c 'SAVE_BYTES=%s' "$prefix.tar"
docker info
cat /sys/fs/cgroup/cloudchamber/memory.peak 2>/dev/null || true
df -B1 /var/lib/docker
cat "$prefix.usage"
