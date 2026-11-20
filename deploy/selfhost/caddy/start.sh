#!/bin/sh
# Starts Caddy after checking its settings (each refusal exits 64 with a message).
# - Mail collector on (SAM_MAIL_COLLECTOR=on in .state/mail-collector.env, written by
#   `pnpm selfhost:deploy`): the collector UI password is hashed here first, so the Caddy config
#   and the Caddy process see only the hash. Refuses the collector without a password: its UI
#   must never be served unauthenticated.
# - Keep-warm and the frp Login rate limit: refuses values Caddy would misread.
# - Refuses any box port inside the reverse-tunnel lease range.
set -eu
case "${SAM_MAIL_COLLECTOR:-off}" in
off) ;;
on)
	password="${MAIL_COLLECTOR_UI_PASSWORD:-}"
	if [ "${#password}" -lt 32 ] || [ -z "${MAIL_COLLECTOR_UI_USER:-}" ]; then
		echo 'caddy: the mail collector is on without its UI password; run pnpm selfhost:deploy --init' >&2
		exit 64
	fi
	MAIL_COLLECTOR_UI_HASH="$(printf '%s\n' "$password" | caddy hash-password)"
	export MAIL_COLLECTOR_UI_HASH
	unset MAIL_COLLECTOR_UI_PASSWORD password
	;;
*)
	echo "caddy: SAM_MAIL_COLLECTOR must be on or off" >&2
	exit 64
	;;
esac
# Keep-warm (keep-warm/on.caddy). A bad value must fail here with a clear message, not as a
# missing import file or a Caddy duration parse error.
case "${SAM_KEEP_WARM:-on}" in
on | off) ;;
*)
	echo "caddy: SAM_KEEP_WARM must be on or off" >&2
	exit 64
	;;
esac
case "${SAM_KEEP_WARM_INTERVAL:-5s}" in
[1-6]s) ;;
*)
	echo "caddy: SAM_KEEP_WARM_INTERVAL must be 1s to 6s (a longer interval widens the cold window after each 30 s celld pool tick)" >&2
	exit 64
	;;
esac
# frp Login rate limit (sam.d/frp.caddy). Caddy would read a bad value as a parse error.
case "${SAM_FRP_LOGIN_RATE_LIMIT_EVENTS:-60}" in
'' | *[!0-9]* | 0*)
	echo "caddy: SAM_FRP_LOGIN_RATE_LIMIT_EVENTS must be a positive integer" >&2
	exit 64
	;;
*) ;;
esac
case "${SAM_FRP_LOGIN_RATE_LIMIT_WINDOW:-1m}" in
[1-9]s | [1-9][0-9]s | [1-9]m | [1-9][0-9]m | 1h) ;;
*)
	echo "caddy: SAM_FRP_LOGIN_RATE_LIMIT_WINDOW must be 1s-99s, 1m-99m or 1h" >&2
	exit 64
	;;
esac
# No box listener may lie inside the reverse-tunnel lease range (gateway.env). The deploy checks
# the same (scripts/selfhost/box-settings.ts resolveTunnelPortRange), but compose takes a port from
# the shell before the .env, so this checks the values the stack really runs with. A port inside
# the range could be leased to a node: the Worker and Caddy would then send that node's traffic,
# with its credentials, to celld's unauthenticated operator API or another box service.
# Each bound must be a plain number: a malformed one (`1:2`, `20000x`) would make the `-ge`/`-le`
# tests below error, which `if` reads as false, silently skipping the check.
start="${REVERSE_TUNNEL_PORT_RANGE_START:-}"
end="${REVERSE_TUNNEL_PORT_RANGE_END:-}"
for bound in "$start" "$end"; do
	case "$bound" in
	'' | *[!0-9]*)
		echo "caddy: REVERSE_TUNNEL_PORT_RANGE_START/END missing from gateway.env or not a number; run pnpm selfhost:deploy --init" >&2
		exit 64
		;;
	*) ;;
	esac
done
# SAM_MX_LISTEN is a listen address ([host]:port): its port is the part after the last ':'. sam-mx
# hands it to Go's net.Listen, which refuses a bare port, so the inbound-mail service would
# restart-loop: refuse it here.
# Go also refuses a host with an unbracketed ':' (`::2525`: "too many colons in address"): an
# IPv6 host must be bracketed.
case "${SAM_MX_LISTEN:-}" in
\[*\]:*) ;;
*\[* | *\]* | *:*:*)
	echo "caddy: SAM_MX_LISTEN must be a listen address [host]:port with an IPv6 host in brackets (e.g. [::]:2525), got ${SAM_MX_LISTEN}" >&2
	exit 64
	;;
*:*) ;;
*)
	echo "caddy: SAM_MX_LISTEN must be a listen address [host]:port (e.g. :25 or 0.0.0.0:2525), not a bare port" >&2
	exit 64
	;;
esac
proxy_port=
for name in GCE_METADATA_PROXY_PORT HTTP_PORT HTTPS_PORT CELLD_PORT CELLD_INTERNAL_PORT FRPS_BIND_PORT OBJECTSTORE_PORT \
	OBJECTSTORE_CONSOLE_PORT MAIL_COLLECTOR_SMTP_PORT MAIL_COLLECTOR_UI_PORT SAM_MX_LISTEN; do
	eval "port=\"\${$name:-}\""
	port="${port##*:}"
	case "$port" in
	'' | *[!0-9]*)
		echo "caddy: $name must be set to a port number (docker-compose.yml passes every box port)" >&2
		exit 64
		;;
	*) ;;
	esac
	# Same bounds as the deploy (box-settings.ts boxPort): a compose run from another shell can
	# override a port the deploy never saw. Services with no capability cannot bind below 1024.
	min=1
	case "$name" in
	CELLD_PORT | CELLD_INTERNAL_PORT | FRPS_BIND_PORT | GCE_METADATA_PROXY_PORT | MAIL_COLLECTOR_SMTP_PORT | MAIL_COLLECTOR_UI_PORT) min=1024 ;;
	*) ;;
	esac
	if [ "${#port}" -gt 5 ] || [ "$port" -lt "$min" ] || [ "$port" -gt 65535 ]; then
		echo "caddy: $name ($port) must be a port between $min and 65535" >&2
		exit 64
	fi
	if [ "$name" = GCE_METADATA_PROXY_PORT ]; then
		proxy_port="$port"
	elif [ "$port" -eq "$proxy_port" ]; then
		echo "caddy: GCE_METADATA_PROXY_PORT ($proxy_port) collides with $name" >&2
		exit 64
	fi
	if [ "$port" -ge "$start" ] && [ "$port" -le "$end" ]; then
		echo "caddy: $name ($port) lies inside the reverse-tunnel range $start-$end; a node could be leased it. Change the port or REVERSE_TUNNEL_PORT_RANGE_START/END, then pnpm selfhost:deploy --init" >&2
		exit 64
	fi
done
unset start end bound name port min proxy_port
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
