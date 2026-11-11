#!/bin/sh
# Starts Caddy. With the mail collector on (SAM_MAIL_COLLECTOR=on in .state/mail-collector.env,
# written by `pnpm selfhost:deploy`), the collector UI password is hashed here first, so the
# Caddy config and the Caddy process see only the hash. Refuses to start with the collector on
# and no password: its UI must never be served unauthenticated.
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
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
