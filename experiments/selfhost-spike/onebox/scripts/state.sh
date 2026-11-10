#!/usr/bin/env bash
# Print a comparable fingerprint of all application state served at $1 (default 127.0.0.1:8080).
B=${1:-http://127.0.0.1:8080}
for n in 0 1 2 3; do printf 'do.load%s=%s ' $n "$(curl -s "$B/do/keys?name=load$n" | jq -r '.keys|sort|join(",")' | sha256sum | cut -c1-12)"; done
printf 'do.counts=%s ' "$(for n in 0 1 2 3; do curl -s "$B/do/keys?name=load$n" | jq -r .count; done | paste -sd/)"
printf 'd1=%s/%s ' "$(curl -s $B/d1/keys | jq -r .count)" "$(curl -s $B/d1/keys | jq -r '.keys|sort|join(",")' | sha256sum | cut -c1-12)"
printf 'kv.hello=%s ' "$(curl -s "$B/kv?k=hello" | jq -r .v)"
printf 'r2=%s ' "$(curl -s "$B/r2list" | jq -c '[.[]|"\(.key):\(.size)"]|join(",")' | sha256sum | cut -c1-12)"
echo
