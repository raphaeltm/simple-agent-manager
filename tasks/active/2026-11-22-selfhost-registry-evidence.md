# Self-host multi-box step 3: does a box need a container registry? (evidence)

Self-hosting only. Hosted SAM is unaffected: no code changed.

Plan: idea `01M7V5DMWTXWDMCWA5T4YC9HC5`, step 3 ("check scope first; build nothing yet").
Task `01M8265E185QAYMQJH7VESFK19`, coordinator `01M7XCE59V5X0WTNF1X3NFZP5J`.

## Part A: shared box upgraded to main

Box `app.vmtest.sam2.party` (GCP `sam-vm-control-plane-test`, VM `sam-box`), TLS mode
`dns-googleclouddns` kept (not switched to DNS on the box).

- [x] `pnpm selfhost:upgrade --to 311f6259c86a…` (main) from `b1ebe0314`, by the box's own
      upgrader: encrypted pre-upgrade backup `backups/pre-upgrade-2026-11-22T18-05-48-779Z`
      (9,723 objects, celld down 18 s), DO migration preflight passed, key-agent and egress-fence
      rebuilt, stack restarted, "healthy". D1 migrations: none.
- [x] Still sealed: `secrets status` = gcp-kms, 3 bundles.
- [x] `/health` 200, app 200.
- [x] OTP sign-in for `agent-test@vmtest.sam2.party` (mail collector): send 200, sign-in 200,
      session user returned.
- [x] Stored credential decrypts: `GET /api/credentials/agent` returns the opencode key masked.
- [x] Hosted-git: token + clone of `adopt-smoke-…`, `git fsck` exit 0; anonymous clone 401.
- [x] Heap: 0 heap-limit rows in `platform_errors` in the 20+ min after the upgrade.

Found on the way (not caused by the upgrade): before the upgrade the box had **810 heap-limit
rows**. From 2026-11-21 08:45Z until the restart at 18:09Z today (about 33 h), every 5-minute
sweep failed `deployment_release_retention` and `gcp_price_table` with "the isolate is over its V8
heap limit, so it stopped materializing a result set". The box had been on `b1ebe031` since
2026-11-20 22:36Z, so it started ~10 h into an unchanged deploy and only a celld restart cleared
it. The first post-upgrade sweep (18:10Z) had 0 failed sweeps. Recorded on the existing heap idea
`01M7W6ZTZETXE75N8NRKR3R0CF`.

## Part B: image sources on a box

Fixture: user `agent-test`, a fresh SAM-hosted project `registry-evidence-esfk19` (deleted
afterwards). One GCP deployment node `01M827HMDJGRJKCC6CAREPYMQJ` (reverse tunnel), up
18:15:56Z to ~18:27Z, then deleted with its environment. Cloud inventory is back to `sam-box` only.
Added the Cloud DNS record `*.apps.vmtest.sam2.party A 35.233.124.74`, which the README requires
for app deployments on a box without DNS on the box. Caddy got the `*.apps` wildcard certificate
by DNS-01 through Cloud DNS right after the upgrade.

| # | Image source | Result on the box | Users hit it? |
|---|---|---|---|
| 1 | Public images (nginx + postgres) | **Works**. Applied in ~4.5 min, app 200 over HTTPS through the box, unregistered host 404, both containers running. Registry mint skipped: `deploy_release.registry_credentials_skipped` "CF_ACCOUNT_ID and CF_API_TOKEN must be configured" (`deploy-release-callback.ts`), harmless. | Yes, the main path |
| 1b | Same with a named volume | **Fails 500**: "Provider \"gcp\" does not support block volumes". Already tracked: `tasks/backlog/2026-11-22-release-volume-unsupported-provider-500.md`. Not registry-related. | Yes, any GCP box user with a database volume |
| 2 | Build-backed compose (compose-publish, bucket artifacts) | **Fails before any registry is involved.** The box has no presign config, so `compose-image-artifacts/init` throws "R2 S3 credentials not configured" (`compose-image-artifacts.ts` → `getR2PresignTarget`). Live probe of the same check: task attachment upload returns 403 "File attachments are not configured (R2 S3 credentials missing)". The documented fix (README "Object store and presigned uploads": a prefix-scoped HMAC key) **cannot be done in this GCP org**: HMAC key creation for a service account is refused by `constraints/iam.disableServiceAccountKeyCreation` (enforced by default on new Google Cloud orgs). The publish itself was not driven end to end: it is started only by an agent's `deployments_write publish` MCP call, and the OpenCode test key is limited to ping-pong sessions. | Yes: "deploy this" from any agent on a GCS box |
| 3 | Private registry pull (legacy path, `registry-credentials.ts`, `REGISTRY_HOST`) | **Fails, as designed.** Tag refs are refused at submission: SAM namespace `registry.cloudflare.com/…/sam-<project>/web:v1` → 400 "Authentication failed … Check registry credentials"; `ghcr.io/…private:v1` → 400 "Token exchange failed: 403". A digest-pinned SAM-namespace ref is accepted, then the node's `docker compose pull` fails "pull access denied", the release goes `failed` and the node agent reverts to the previous release (the app kept serving 200). | Rarely. The only credential SAM mints is for its own Cloudflare namespace, which nothing pushes to any more (row 4). Third-party private registries have no credential feature on hosted SAM either. |
| 4 | Registry push credentials (`registry-push-credentials-callback.ts`) | **Not applicable: dead code.** No caller exists. The vm-agent publish path is R2-first; `routeMintPushCredentials` and the `PushCredentials` types in `packages/vm-agent/internal/publish/` are never used. On a box the route would fail like row 3 (no CF account/token). | No |
| 5 | Devcontainer cache (`DEVCONTAINER_CACHE_ENABLED`) | **Off and harmless.** Worker var is `false`. Even set to `true` on a box, `getCacheConfig` returns null without CF credentials, so the vm-agent gets no cache credential and builds normally (`applyDevcontainerCacheCredentials` needs a ref). | No |

## Recommendation: (c) no registry; fix presigned uploads on a box instead

- Nothing users do in normal use needs a registry on a box. Public images work. Build-backed
  images already travel as bucket artifacts. The registry-only paths are a Cloudflare-namespace
  pull credential with nothing left to pull, and a dead push route.
- What actually blocks app deployments on a GCS box is the **object-store presign credential**,
  not a registry. The same gap disables chat attachments and direct session-snapshot uploads.
  A CNCF distribution registry with the S3 driver would hit the same HMAC-key refusal on GCP.
- Smaller next step: let a box sign bucket URLs without a long-lived HMAC key, for example GCS V4
  signed URLs signed by the box's own identity (IAM `signBlob` through the metadata proxy), or
  Worker-streamed uploads to the R2 binding. Then prove one build-backed publish on the box. Idea
  filed (see below).
- Separate cleanup (touches hosted code, so its own PR): remove the dead registry push route and
  the unused vm-agent constant and types. Backlog task filed.

## Follow-ups filed

- [x] Idea `01M828EKSVADDDZF7VXA5HPKK5`: presigned uploads on a GCS box without HMAC keys (blocks build-backed publish).
- [x] Backlog `tasks/backlog/2026-11-22-remove-dead-registry-push-credentials.md`: remove the dead push route and vm-agent types.
- [x] Heap idea `01M7W6ZTZETXE75N8NRKR3R0CF`: note on the 33 h sweep failure window.

## Cleanup

- [x] Test environments, deployment node and test project deleted.
- [x] Temporary GCP objects reverted: `sam-box-presign` service account deleted, its bucket IAM
      binding removed, my temporary `roles/storage.hmacKeyAdmin` removed.
- [x] Temporary SSH key metadata and firewall rule `sam-smoke-ssh-esfk19` removed; box scratch removed.
