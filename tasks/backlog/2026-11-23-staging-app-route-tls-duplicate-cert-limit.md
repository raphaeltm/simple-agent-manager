# Staging app route serves a TLS internal error after repeated environment restarts

## Problem

On 2026-11-23 ~03:13Z, staging environment `01KVJDV913S8W7KK32HTZTK0H8` (node
`01M833KW2TE4T4F7M487DNZ2AS`, Hetzner, started 02:26Z, release applied) answered
`https://r1-app-80-01kvjdv913s8w7kk32htztk0h8.apps.sammy.party/` with a TLS handshake failure
(`tlsv1 alert internal error` from Caddy on the node). The A record was correct (node IP) and
plain HTTP returned Caddy's 308 redirect. On 2026-11-22 the same URL served HTTPS 200 with a valid
certificate (PR #2976 staging evidence).

## Context

Probable cause (not yet confirmed from Caddy's own logs, which are not in the node log stream):
app-route hostnames are deterministic per environment, and this environment was started on 8
fresh deployment nodes on 2026-11-22 (staging tests for #2974/#2976), each obtaining a new Let's
Encrypt certificate for the same hostname. Let's Encrypt allows 5 duplicate certificates per
exact hostname set per 7 days, after which Caddy cannot obtain one and fails the handshake.
Found while verifying PR #2981 on staging; that PR touches no route/TLS code.

If confirmed, production users who stop and start one environment more than ~5 times a week hit
the same wall.

## Acceptance Criteria

- [ ] Confirm the cause from Caddy's logs on a deployment node (debug package)
- [ ] Caddy logs reach the node log stream (source `caddy`) so ACME failures are visible
- [ ] Certificates survive node replacement (store and reuse per hostname, e.g. in R2), or the
      UI/API surfaces the ACME rate-limit state instead of a silent TLS failure
- [ ] Staging tests that restart one environment repeatedly use fresh environments or the Let's
      Encrypt staging CA (`ACMECA`)
