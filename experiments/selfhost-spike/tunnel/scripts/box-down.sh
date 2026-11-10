#!/usr/bin/env bash
source "$(dirname "$0")/env.sh"
for p in authz frps celld; do [ -f "$LOGS/$p.pid" ] && kill "$(cat "$LOGS/$p.pid")" 2>/dev/null; rm -f "$LOGS/$p.pid"; done; sleep 0.5; true
