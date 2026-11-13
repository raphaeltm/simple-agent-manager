# Self-host platform-key rotation (`pnpm selfhost:secrets rotate`)

Task K2 (SAM task `01M795839ZQE13WV0BN27G90VJ`), idea `01M77AG90EQB4F9VAKDVH94ZK4`, follows PR #2692
("Decisions for Raphaël" item 6). Draft PR, base `sam/selfhost-pass-2`, never main, not merged by
an agent. No staging, no box, no cloud project.

## Problem

Before sealed secrets, every platform key of a self-hosted box sat in plaintext in old celld deploy
versions in the fleet bucket and in old backups (R4: 27 plaintext versions, 10 backup locations).
`pnpm selfhost:secrets plaintext --purge` can delete copies, but deletion does not undo an earlier
read: the keys themselves must be replaced. No rotation existed.

## Research findings

Inventory (code-derived, 2026-11-13; file:line in the PR body):

| Key | Protects | Other holders | What breaks on change | Rotation |
|---|---|---|---|---|
| ENCRYPTION_KEY (AES role, via getCredentialEncryptionKey) | D1: credentials, cc_credentials, platform_credentials, project/profile/skill runtime env vars+files (is_secret), deployment_secrets, deployment_environment_config_vars, mcp_connections (url/token/headers); DO InteractionStore details (<=4h deadline + 1h purge); KV bootstrap tokens (15 min) | none | every stored credential unreadable | transitional bundle (new primary, `ENCRYPTION_KEY_PREVIOUS` fallback in decrypt), re-encrypt D1 in bounded batches via a self-host-only control endpoint, verify, wait out DO/KV lifetimes, final bundle |
| ENCRYPTION_KEY (library KEK) | R2 customMetadata x-enc-wrapped-dek | none | library files unreadable | same, re-wrap DEKs (body unchanged, metadata rewritten) |
| ENCRYPTION_KEY (lookup HMAC) | api tokens, invite links, webhook token/delivery hashes, rate-limit key | none | every API token / invite / webhook URL stops matching | pinned as TOKEN_HASH_KEY = old value (lookup hashes of 256-bit random tokens: key exposure grants nothing); decision for Raphaël |
| ENCRYPTION_KEY (derived) | hosted-git tokens (minted per git op), reverse-tunnel frp creds (lease stores hash; login compares hash), archive cursors | VMs (frp cred in cloud-init) | in-flight git op may fail once; provisioning resume across the switch fails closed; existing leases keep working | no app change; report active leases (residual exposure until those nodes are replaced) |
| ENCRYPTION_KEY via fingerprints | nodes.placement_credential_fingerprint = sha256(iv,ciphertext) | - | strict node deletion fails closed (rule 71) | remap fingerprint old->new in the same D1 batch as the re-encryption (same plaintext proven) |
| ENCRYPTION_KEY via mirrors | credentials<->cc_credentials identical (ciphertext, iv) pairs | - | mirror pairing breaks | rewrite every row holding the old pair with the identical new pair in one batch |
| BETTER_AUTH_SECRET (defaults to ENCRYPTION_KEY) | session cookie signatures, cookieCache, API-token session cookies, accounts.access_token/refresh_token (XChaCha) | browsers | everyone signed out; OAuth tokens unreadable | pin to old value during encryption-key; own rotation: better-auth versioned secrets (`secrets:[{v,new}]`, legacy=old), re-encrypt accounts tokens to `$ba$v$`, verify, drop previous. Users signed out once |
| JWT_PRIVATE/PUBLIC_KEY | callback tokens (24h, heartbeat refresh at 50%), terminal/node-mgmt/port/local-forward tokens, JWKS, OIDC identity tokens | VMs (callback token, JWKS cache by kid), external WIF/agent-sign-in verifiers | vm-agent treats 401 as terminal: every node goes dark | overlap: JWT_PUBLIC_KEY_PREVIOUS accepted until JWT_PUBLIC_KEY_PREVIOUS_UNTIL (default 25h), JWKS publishes both, new key gets its own kid (JWT_KEY_ID); finish after the window |
| DEPLOY_SIGNING pair | deploy payload signatures (3600 s, not stored) | nodes get pubkey each heartbeat | an in-flight apply may be refused once | swap both halves, deploy |
| VAPID pair | push subscriptions (applicationServerKey in browser) | browsers | push stops until the user re-enables notifications | swap, deploy; impact stated |
| PREVIEW_SIGNING_KEY | preview URLs (300 s) | browsers | open previews fail <=5 min | swap, deploy |
| REVERSE_TUNNEL_GATEWAY_SECRET | frps plugin auth, Caddy forward_auth, sam-mx | frps, Caddy, sam-mx (gateway.env) | node logins/WebSockets/inbound mail 401 until both sides match | Worker accepts REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE; deploy (old+new), write gateway.env + recreate frps/caddy/sam-mx, deploy (new only) |
| SAM_KEY_AGENT_SIGNING_KEY | agent answer signatures | per-bundle, verify key per Worker version | nothing (old version keeps its bundle) | new bundle + deploy |
| SAM_INSTALLATION_ID | not a secret (VM labels, bundle binding) | VMs | orphaned VMs | never rotated |
| AGENT_SIGN_IN_TRUST | not a secret (issuer/allowlists) | - | - | not rotated |
| secrets.env externals (GitHub App, OAuth clients, SMTP, R2 presign, fleet bucket creds) | external | external | - | printed instructions |

Design: rotation state sealed in bundles (never plaintext); journal `.state/key-agent/rotation/journal.json` (names, ids, phases, cursors; no values); pre-rotation snapshot sealed at `.state/key-agent/rotation/<id>/before.json` (rollback source, the "old key kept" anchor). Control endpoint `/__sam-selfhost/key-rotation` only in the celld wrapper, HMAC-authenticated with a per-rotation `SAM_KEY_ROTATION_CONTROL_KEY` present only in transitional bundles.

## Implementation checklist

- [ ] Inventory every platform key and secret (code-derived), what it protects, who holds copies
- [ ] Per-key rotation procedure (ENCRYPTION_KEY re-encryption; signing-key overlap; gateway secret order)
- [ ] `rotate --all | <name>`, `--dry-run` plan with user impact per key
- [ ] Backup first; journal that survives interruption; `--resume`
- [ ] Verification per key; automatic rollback of a key whose verification fails
- [ ] Reseal at the end; tell the operator purge/backup deletion is now meaningful; external secrets list
- [ ] Cloudflare behaviour unchanged; shared code behind an explicit entry point
- [ ] Tests: real SQL engine, interruption + resume, undecryptable row skipped, failed verification rolls back,
      signing-key overlap accepted then expired, end to end on real celld + pinned object store
- [ ] "Old key not deleted before proof" guard proven discriminating
- [ ] deploy/selfhost/README.md in the same commits
- [ ] security-auditor once; CRITICAL/HIGH fixed
- [ ] CI green on branch (manual `gh workflow run ci.yml --ref <branch>`)
- [ ] Draft PR with "How to run on the box", "Decisions for Raphaël", "Before main"; post on feature.selfhost-spike

## Acceptance criteria

- An operator can replace every exposed platform key with one command, with a dry run first.
- No stored credential is lost: every encrypted row is readable under the new key before the old key leaves
  the Worker; an undecryptable row is reported and never modified.
- An interruption at any point resumes; a failed verification rolls the key back.
