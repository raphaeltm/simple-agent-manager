#!/bin/sh
# SPIKE ONLY — Variant A, documented flags, persistent-path diagnostic log.
set -eu
dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false --ip-forward=false --exec-opt native.cgroupdriver=cgroupfs > /var/log/dockerd.log 2>&1 &
timeout 60 sh -c 'until docker version >/dev/null 2>&1; do sleep 0.2; done'
echo 'Docker is ready'
wait
