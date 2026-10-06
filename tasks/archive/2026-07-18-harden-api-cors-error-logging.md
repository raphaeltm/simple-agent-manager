# Harden API credentialed CORS and sensitive error logging

## Context

Audit tasks `01KXT1E0Z1GNCNQ5HYZVE67SB5` and `01KXT25E7FSNR952HMGACHSQE9` flagged credentialed CORS over-trusting every `BASE_DOMAIN` subdomain and normal logs exposing raw BetterAuth/global error details.

## Acceptance Criteria

- [x] Credentialed CORS still works for legitimate app/docs/API origins derived from `BASE_DOMAIN`.
- [x] Credentialed CORS is not granted to workspace, workspace-port, VM, or arbitrary user-controlled subdomains.
- [x] BetterAuth error logging avoids raw response bodies.
- [x] Global error logging avoids raw stack traces, tokens, cookies, and credentials in normal logs.
- [x] Tests cover allowed/disallowed CORS behavior and logging redaction.
- [x] PR is opened without merging.
