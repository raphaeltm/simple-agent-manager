---
title: Configuration Reference
description: All environment variables, secrets, and configurable settings for SAM.
---

SAM uses environment variables for platform configuration. User-specific settings (cloud provider tokens, agent API keys) are stored encrypted in the database, not as environment variables.

:::note
This reference covers the most important configuration variables. For the complete list including advanced tuning options, see [`apps/api/.env.example`](https://github.com/raphaeltm/simple-agent-manager/blob/main/apps/api/.env.example) in the source code.
:::

## Platform Secrets

These are Cloudflare Worker secrets, set during deployment. Pulumi auto-generates security keys on first deploy.

| Secret                                     | Description                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                           | AES-256-GCM master key. Used for BetterAuth session cookies and user credential encryption unless a purpose-specific override below is set (auto-generated)                                                                  |
| `BETTER_AUTH_SECRET`                       | Optional purpose-specific override for BetterAuth session cookie signing/encryption. Falls back to `ENCRYPTION_KEY` when unset (`apps/api/src/lib/secrets.ts`)                                                               |
| `CREDENTIAL_ENCRYPTION_KEY`                | Optional purpose-specific override for AES-GCM encryption of user cloud/agent credentials. Falls back to `ENCRYPTION_KEY` when unset (`apps/api/src/lib/secrets.ts`)                                                         |
| `JWT_PRIVATE_KEY`                          | RSA-2048 private key for signing tokens (auto-generated)                                                                                                                                                                     |
| `JWT_PUBLIC_KEY`                           | RSA-2048 public key for token verification (exposed via JWKS)                                                                                                                                                                |
| `DEPLOY_SIGNING_PRIVATE_KEY`               | Ed25519 private key for signing deployment apply payloads (auto-generated)                                                                                                                                                   |
| `DEPLOY_SIGNING_PUBLIC_KEY`                | Ed25519 public key derived during deployment for deployment node verification (auto-generated)                                                                                                                               |
| `VAPID_PRIVATE_KEY`                        | Base64url P-256 private scalar used to authenticate Web Push delivery (auto-generated)                                                                                                                                       |
| `VAPID_PUBLIC_KEY`                         | Uncompressed base64url P-256 public key returned to browsers at runtime (derived during deployment)                                                                                                                          |
| `VAPID_SUBJECT`                            | RFC 8292 contact URI for Web Push, defaulting to the deployment app origin (generated during deployment)                                                                                                                     |
| `CF_API_TOKEN`                             | Cloudflare API token for infrastructure, DNS, Origin CA certificate issuance, observability, AI Gateway, Containers, and admin logs. Requires **Account → Containers → Edit** and **Account → SSL and Certificates → Edit**. |
| `CF_AIG_TOKEN`                             | Optional narrower Cloudflare AI Gateway Unified Billing token                                                                                                                                                                |
| `CF_ZONE_ID`                               | Cloudflare zone ID for DNS record management                                                                                                                                                                                 |
| `CF_ACCOUNT_ID`                            | Cloudflare account ID                                                                                                                                                                                                        |
| `DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN`  | Optional narrower Cloudflare token for managed devcontainer registry credentials                                                                                                                                             |
| `DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID` | Optional Cloudflare account override for managed devcontainer registry credentials                                                                                                                                           |
| `GITHUB_CLIENT_ID`                         | Optional fallback GitHub App client ID for OAuth; runtime admin config takes precedence                                                                                                                                      |
| `GITHUB_CLIENT_SECRET`                     | Optional fallback GitHub App client secret for OAuth; runtime admin config takes precedence                                                                                                                                  |
| `GITHUB_APP_ID`                            | Optional fallback GitHub App ID for installation tokens; runtime admin config takes precedence                                                                                                                               |
| `GITHUB_APP_PRIVATE_KEY`                   | Optional fallback GitHub App private key (PEM or base64); runtime admin config takes precedence                                                                                                                              |
| `GITHUB_APP_SLUG`                          | Optional fallback GitHub App URL slug; runtime admin config takes precedence                                                                                                                                                 |
| `GITHUB_WEBHOOK_SECRET`                    | Optional fallback GitHub App webhook HMAC secret; runtime admin config takes precedence                                                                                                                                      |
| `GITLAB_HOST`                              | Optional fallback GitLab OAuth host, such as `https://gitlab.com`; runtime admin config takes precedence                                                                                                                     |
| `GITLAB_CLIENT_ID`                         | Optional fallback GitLab OAuth application ID; runtime admin config takes precedence                                                                                                                                         |
| `GITLAB_CLIENT_SECRET`                     | Optional fallback GitLab OAuth secret; runtime admin config takes precedence                                                                                                                                                 |
| `TRIAL_CLAIM_TOKEN_SECRET`                 | Trial onboarding HMAC secret (auto-generated)                                                                                                                                                                                |

## Worker Variables

Set as `[vars]` in `wrangler.toml` or as environment variables:

| Variable                                      | Default               | Description                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_DOMAIN`                                 | —                     | Root domain for the deployment (e.g., `example.com`)                                                                                                                                                                                                                                                                                                                                                             |
| `PREVIEW_BASE_DOMAIN`                         | `preview.BASE_DOMAIN` | Full isolated hostname used for interactive HTML previews                                                                                                                                                                                                                                                                                                                                                        |
| `PREVIEW_URL_TTL_SECONDS`                     | `300`                 | Lifetime of project/file/version-scoped interactive preview URLs in seconds                                                                                                                                                                                                                                                                                                                                      |
| `PREVIEW_SIGNING_KEY`                         | generated             | Deployment-owned HMAC key generated and persisted by Pulumi; not a manual prerequisite                                                                                                                                                                                                                                                                                                                           |
| `VERSION`                                     | —                     | Deployment version string                                                                                                                                                                                                                                                                                                                                                                                        |
| `SETUP_TOKEN`                                 | —                     | Plaintext first-run setup token generated during deploy and readable in the Cloudflare dashboard while setup is incomplete                                                                                                                                                                                                                                                                                       |
| `SETUP_FORCE`                                 | _(unset)_             | Set to `true` to reopen `/setup` for lockout recovery                                                                                                                                                                                                                                                                                                                                                            |
| `SETUP_RATE_LIMIT_MAX_ATTEMPTS`               | `10`                  | Max setup-token attempts per identifier/window                                                                                                                                                                                                                                                                                                                                                                   |
| `SETUP_RATE_LIMIT_WINDOW_SECONDS`             | `900`                 | Setup-token attempt window in seconds                                                                                                                                                                                                                                                                                                                                                                            |
| `PLATFORM_CONFIG_CACHE_MS`                    | `60000`               | Per-isolate cache TTL for the resolved platform integration config (the `GITHUB_*`/`GITLAB_*`/`GOOGLE_LOGIN_*` fallbacks above and their runtime admin overrides). Resolving costs 13 D1 queries and runs on the auth preamble of every authenticated request. After a config change, isolates that already hold a cached copy converge within this window. Set to `0` to disable caching and always re-read D1. |
| `GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS` | `3000`                | KV cache TTL for GitHub App installation tokens. The default is shorter than GitHub's one-hour token lifetime. Set to `0` to disable writes for new cache entries.                                                                                                                                                                                                                                               |
| `GITHUB_REPO_ACCESS_CACHE_TTL_SECONDS`        | `300`                 | KV cache TTL for per-user, per-installation, per-repository GitHub access checks used by the Files page. Set to `0` to disable writes for new cache entries.                                                                                                                                                                                                                                                     |
| `GITHUB_TREE_CACHE_TTL_SECONDS`               | `86400`               | KV cache TTL for immutable Git tree responses keyed by commit SHA. Branch refs are resolved to a commit SHA before lookup. Set to `0` to disable writes for new cache entries.                                                                                                                                                                                                                                   |
| `PROJECT_MULTIPLAYER_CACHE_TTL_MS`            | `10000`               | Per-isolate cache TTL for project multiplayer state counts used by trigger-bearing pages. Set to `0` to disable the cache.                                                                                                                                                                                                                                                                                       |
| `CREDENTIAL_ATTRIBUTION_CACHE_TTL_MS`         | `10000`               | Per-isolate cache TTL for project credential attribution health used by trigger-bearing pages. Set to `0` to disable the cache.                                                                                                                                                                                                                                                                                  |

## GitHub Environment Variables

Set in GitHub Settings → Environments → production:

| Variable                                           | Description                                                                                                                                                      | Example                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `BASE_DOMAIN`                                      | Deployment domain                                                                                                                                                | `example.com`                            |
| `RESOURCE_PREFIX`                                  | Domain-derived Cloudflare resource name prefix                                                                                                                   | `sa379a6`                                |
| `PULUMI_STATE_BUCKET`                              | R2 bucket for Pulumi state                                                                                                                                       | `sa379a6-pulumi-state`                   |
| `CF_CONTAINER_ENABLED`                             | Optional instant-session runtime toggle. Generated deploys default to `true`; set `false` to force VM runtime.                                                   | `false`                                  |
| `WORKER_SECRET_BULK_MAX_OPS`                       | Optional deploy-script limit for queued Worker secret create/update/delete operations in one `wrangler secret bulk` payload. Defaults to `100`; range `1`–`100`. | `75`                                     |
| `D1_RESTORE_RECOVERY_WINDOW_DAYS`                  | Optional D1 restore window for accounts with narrower retention. Defaults to `30`; range `1`–`30`.                                                               | `7`                                      |
| `D1_MIGRATION_CHURNING_TABLES`                     | Optional comma-separated `<binding>.<table>` subset of the reviewed retention/expiry table list. May narrow the built-in list but cannot expand it.              | `OBSERVABILITY_DATABASE.platform_errors` |
| `D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT` | Maximum allowed decrease for reviewed churning tables. Defaults to `50`; range `0`–`100`. A decrease exactly at the limit is accepted.                           | `25`                                     |

The reviewed default churning selectors are `DATABASE.deployment_releases`, `DATABASE.github_webhook_deliveries`, `DATABASE.project_files`, `DATABASE.registry_credential_rate_limits`, `DATABASE.session_snapshots`, `DATABASE.sessions`, `DATABASE.trial_waitlist`, `DATABASE.trigger_executions`, `DATABASE.verifications`, `DATABASE.webhook_deliveries`, and `OBSERVABILITY_DATABASE.platform_errors`. All other application tables retain zero row-decrease tolerance. Leave `D1_MIGRATION_CHURNING_TABLES` unset to use the complete reviewed default list.

`RESOURCE_PREFIX` is generated from `BASE_DOMAIN` as `s` plus the first six hex
characters of the domain's SHA-256 hash. The self-host onboarding flow fills it
in for you.

### App deployment image-resolution safety

These optional Worker variables bound the server-side OCI registry lookups used
when a deployment release submits tag-based images. Digest-pinned images are
stored without registry network resolution.

| Variable                                            | Default | Description                                                        |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `DEPLOYMENT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS`       | `10000` | Per-registry request timeout                                       |
| `DEPLOYMENT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS`         | `60000` | Total tag-resolution wall-clock budget per release submission      |
| `DEPLOYMENT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS`       | `200`   | Maximum outbound registry/token fetches per resolver instance      |
| `DEPLOYMENT_IMAGE_RESOLVE_MAX_REDIRECTS`            | `2`     | Maximum manually validated HTTPS redirects per outbound request    |
| `DEPLOYMENT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES` | `65536` | Maximum bearer-token JSON response size                            |
| `DEPLOYMENT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES`   | `4`     | Maximum simultaneous outbound resolver fetches                     |
| `DEPLOYMENT_IMAGE_RESOLVE_MAX_SERVICES`             | `50`    | Maximum tag-based image references resolved per release submission |

Required GitHub Actions secrets include `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `PULUMI_CONFIG_PASSPHRASE`. GitHub App/OAuth secrets (`GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_SLUG`, `GH_WEBHOOK_SECRET`) and Google **login** OAuth secrets (`GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`) are optional environment fallbacks; fresh deployments can set them through `/setup` instead. The separate Google **infra/GCP** OAuth pair (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) is used only for WIF and can be configured by a superadmin at `/admin/integrations`; runtime values override the environment fallback. Service-account JSON users need no infrastructure OAuth client. Deploy signing keys are generated and persisted by Pulumi during deployment; GitHub Environment values are only needed for explicit key overrides.

:::note[Naming convention]
GitHub App secrets use `GH_*` prefix (e.g., `GH_CLIENT_ID`, `GH_WEBHOOK_SECRET`) because GitHub Actions secret names cannot start with `GITHUB_*`. When present, the deploy workflow maps those `GH_*` secrets to `GITHUB_*` Worker secrets. Runtime admin config in D1 is resolved first, then these environment fallbacks, then unset.
:::

## CLI Environment Variables

These variables affect the local `sam` CLI process only. They are not Worker runtime variables or GitHub Actions secrets.

| Variable                         | Default   | Description                                                               |
| -------------------------------- | --------- | ------------------------------------------------------------------------- |
| `SAM_CLI_MAX_API_RESPONSE_BYTES` | `1048576` | Maximum API response body bytes the CLI reads before truncating/aborting. |

## Feature Flags

Codex and Claude Code guided subscription login have no feature-on environment variable. They are
available by default when the deployment includes the `SANDBOX`,
`CREDENTIAL_SETUP_SESSION`, and `SETUP_SESSION_POOL` Worker bindings generated by
SAM's deployment configuration. Omitting one of those bindings disables the
guided flow. `SANDBOX_ENABLED` continues to control separate administrative
Sandbox runtime surfaces and is not required for guided login.

| Variable                               | Default  | Description                                                                                         |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `MAX_CONCURRENT_SETUP_SESSIONS`        | `2`      | Maximum concurrent guided credential-setup sessions.                                                |
| `SETUP_SESSION_TTL_MS`                 | `900000` | Guided session lifetime before automatic teardown.                                                  |
| `SETUP_SESSION_CAPTURE_POLL_MS`        | `3000`   | Interval for checking device-login and credential-capture state.                                    |
| `CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS` | `30000`  | Timeout for each Codex app-server JSON-RPC request.                                                 |
| `CLAUDE_SETUP_ENTER_DELAY_MS`          | `1000`   | Delay before sending Enter as a separate stdin write after pasting Claude's browser-displayed code. |
| `CLAUDE_SETUP_EXCHANGE_TIMEOUT_MS`     | `120000` | Maximum wait for Claude's CLI code exchange before a visible timeout.                               |
| `CLAUDE_SETUP_REJECTION_SETTLE_MS`     | `400`    | Wait for Claude CLI Ink redraws to settle before classifying an OAuth error.                        |
| `CLAUDE_SETUP_VERIFICATION_POLL_MS`    | `500`    | Interval for checking the sandbox handoff file for Claude's browser-displayed code.                 |
| `CLAUDE_SETUP_TTY_COLUMNS`             | `512`    | PTY width for `claude setup-token`, reducing opaque-token wrapping.                                 |
| `CLAUDE_SETUP_OUTPUT_BUFFER_BYTES`     | `32768`  | Maximum in-memory Claude PTY output retained for parsing.                                           |
| `CLAUDE_VERIFICATION_CODE_MAX_LENGTH`  | `1024`   | Maximum accepted length of Claude's browser-displayed `code#state` value.                           |
| `CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH` | `160`    | Maximum sanitized Claude CLI diagnostic length shown to the user.                                   |
| `CLAUDE_OAUTH_TOKEN_MAX_LENGTH`        | `8192`   | Maximum captured Claude OAuth token length.                                                         |
| `SETUP_SESSION_SWEEP_MAX_CANDIDATES`   | `50`     | Maximum expired sessions cleaned up by one scheduled sweep.                                         |
| `POOL_LEASE_BUFFER_MS`                 | `300000` | Grace period after session TTL before a leaked capacity lease self-prunes.                          |

The variables below tune the **Instant** (Cloudflare Container) runtime — how long a session stays awake, how long a wake may take, and how many snapshot restores are attempted before a session is failed. See [Instant Sessions](/docs/guides/instant-sessions/) for what each of these means to a user.

| Variable                                   | Default          | Description                                                                                                                                                                                |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CF_CONTAINER_ENABLED`                     | `true`           | Enables Cloudflare Container instant sessions for matching profiles and zero-config runtime selection. Set `false` to force cloud VM runtime.                                              |
| `CF_CONTAINER_SLEEP_AFTER`                 | `1h`             | Normal inactivity window before an Instant container sleeps. Sleep remains recoverable through the runtime-neutral session snapshot.                                                       |
| `CF_CONTAINER_ACTIVE_WORK_MAX_MS`          | `7200000`        | Defensive maximum lifetime for an active-work keepalive lease.                                                                                                                             |
| `CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS` | `300000`         | Interval used to renew the container activity timeout while prompt work is active.                                                                                                         |
| `CF_CONTAINER_WAKE_TIMEOUT_MS`             | `120000`         | Maximum time for a sleeping container to launch, restore its snapshot, and accept the triggering request.                                                                                  |
| `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`       | `2`              | Maximum snapshot restore attempts before SAM reconciles the runtime, workspace, agent session, and active task to a visible terminal recovery failure.                                     |
| `INSTANT_STALE_CALLBACK_MARGIN_MS`         | `60000` (60 sec) | Freshness margin used to reject destructive (error/failed) callbacks arriving from a superseded Instant container generation after the runtime row was reconciled by a completed recovery. |
| `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` | `120000`         | Budget for the synchronous instant-session create-workspace request, which includes the repository clone inside the container.                                                             |
| `CF_CONTAINER_CLONE_FILTER`                | `blob:none`      | Git partial-clone filter forwarded to instant containers as `STANDALONE_CLONE_FILTER`. Set `off` to force full clones.                                                                     |

### Persistent session snapshots and sleep

Sleeping and reclaimed Instant and VM sessions are restored from a snapshot of the agent's home directory and the repository work in progress. A complete snapshot is required before SAM tears down VM compute. None of these limits are surfaced in the UI, so operators should set expectations deliberately — see [What gets restored](/docs/guides/instant-sessions/#what-gets-restored).

| Variable                                    | Default                   | Description                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SNAPSHOT_TTL_DAYS`                 | `7`                       | Snapshot retention. A session sleeping longer than this cannot be fully restored.                                                                                                                                                                                                                                                                                                               |
| `SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`       | `268435456` (256 MiB)     | Max combined size of the home + work-in-progress snapshot. The higher default favors bounded retained R2 state over keeping a VM alive when a typical agent harness has accumulated substantial durable state.                                                                                                                                                                                  |
| `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`    | `268435456` (256 MiB)     | Largest single file the snapshot scanner will include. This matches the total budget so durable agent state databases are not skipped solely because they are larger than the former 50 MiB cap.                                                                                                                                                                                                |
| `SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS` | `30000` (30 sec)          | No-progress timeout for each snapshot upload or download.                                                                                                                                                                                                                                                                                                                                       |
| `SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS`   | `900` (15 min)            | Lifetime of direct R2 upload URLs used so large snapshots do not traverse the Worker request-body boundary. Current agents bind exact length and SHA-256; busy legacy VM agents stream through a current same-user VM relay that independently authenticates both nodes and removes callback credentials before R2. When R2 S3 credentials are unavailable, SAM retains the Worker upload path. |
| `SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS`       | `300000` (5 min)          | Budget for the vm-agent to accept the final checkpoint request. Durable completion is governed by progress reporting rather than this fixed wall clock.                                                                                                                                                                                                                                         |
| `SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS` | `120000` (2 min)          | No-progress watchdog for an accepted final checkpoint. Current vm-agents periodically advance D1 progress while walking HOME or uploading artifacts; if progress stops, SAM completes a degraded snapshot so idle compute can still be released visibly.                                                                                                                                        |
| `SESSION_SNAPSHOT_POLL_INTERVAL_MS`         | `1000` (1 sec)            | Interval used while the Worker waits for a VM agent's asynchronous final checkpoint to commit in D1.                                                                                                                                                                                                                                                                                            |
| `SESSION_SNAPSHOT_OPERATION_TIMEOUT`        | `15m`                     | VM-agent process deadline for one asynchronous checkpoint operation. This uses Go duration syntax.                                                                                                                                                                                                                                                                                              |
| `SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL` | `15s`                     | VM-agent throttle for best-effort progress callbacks during data-scaled snapshot work. This uses Go duration syntax and is passed to newly provisioned VMs and Instant containers.                                                                                                                                                                                                              |
| `SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT`  | `5s`                      | VM-agent timeout for each best-effort snapshot progress callback. This uses Go duration syntax and is passed to newly provisioned VMs and Instant containers.                                                                                                                                                                                                                                   |
| `SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES`      | `262144` (256 KB)         | Maximum snapshot coordination request size accepted by the Worker.                                                                                                                                                                                                                                                                                                                              |
| `SESSION_SNAPSHOT_R2_PREFIX`                | `session-snapshots`       | Private object prefix. Session objects are deleted by the Worker from D1 lifecycle state, not by object age.                                                                                                                                                                                                                                                                                    |
| `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`    | `3`                       | Maximum replacement-VM wake attempts before the sleeping session becomes unavailable.                                                                                                                                                                                                                                                                                                           |
| `SESSION_SLEEP_AFTER_MS`                    | `900000` (15 min)         | ProjectData-recorded idle interval before SAM automatically sleeps a VM session. Runtime heartbeats do not extend this clock. Completed tasks queue sleep immediately; a terminal prompt still marked active becomes eligible once this interval has elapsed.                                                                                                                                   |
| `SESSION_SLEEP_SWEEP_BATCH_SIZE`            | `10`                      | Maximum due session sleep candidates selected and individually claimed by one scheduled sweep.                                                                                                                                                                                                                                                                                                  |
| `SESSION_SLEEP_SWEEP_WALL_BUDGET_MS`        | `20000` (20 sec)          | Soft wall-clock budget for bounded D1/ProjectData eligibility and claim work. After a durable claim, final snapshot and teardown run through the scheduled event's out-of-band lifetime. Remaining unclaimed rows stay due for the next sweep.                                                                                                                                                  |
| `SESSION_SLEEP_RETRY_DELAY_MS`              | `300000` (5 min)          | Retry delay after a fail-closed automatic sleep attempt.                                                                                                                                                                                                                                                                                                                                        |
| `SESSION_SLEEP_MAX_ATTEMPTS`                | `9`                       | Automatic sleep attempts before SAM preserves compute and records an operator-visible failure. Raising the configured budget re-arms previously exhausted rows that are still below the new limit.                                                                                                                                                                                              |
| `SESSION_SLEEP_CLAIM_LEASE_MS`              | `600000` (10 min)         | Time after which an interrupted automatic-sleep claim can be safely reclaimed.                                                                                                                                                                                                                                                                                                                  |
| `HARNESS_BACKGROUND_WORK_LEASE_MS`          | `300000` (5 min)          | Finite sleep-protection lease renewed by normalized harness background-work lifecycle signals. Expiry fails open to ordinary idle-sleep eligibility so a missing terminal signal cannot pin compute forever.                                                                                                                                                                                    |
| `HARNESS_BACKGROUND_WORK_MAX_DURATION_MS`   | `1800000` (30 min)        | Absolute ceiling, measured from the last harness lifecycle **progress** edge rather than the last heartbeat, on how long background work may defer sleep. The sliding lease above is refreshed by periodic re-reports, so an adapter faithfully re-reporting a stale task set (for example an abandoned `run_in_background` dev server) would otherwise pin compute awake indefinitely.         |
| `SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS`  | `600000` (10 min)         | Time after which an interrupted replacement-runtime wake claim can be reconciled or reclaimed.                                                                                                                                                                                                                                                                                                  |
| `SESSION_LIFECYCLE_ERROR_MAX_LENGTH`        | `2048`                    | Maximum sleep/recovery diagnostic detail stored in lifecycle records.                                                                                                                                                                                                                                                                                                                           |
| `SESSION_SNAPSHOT_PURGE_ENABLED`            | `true`                    | Enables bounded expiry cleanup: terminalizes the sleeping chat, deletes its R2 objects, then removes D1 metadata.                                                                                                                                                                                                                                                                               |
| `SESSION_SNAPSHOT_PURGE_BATCH_SIZE`         | `250`                     | Maximum expired snapshot rows deleted per daily purge.                                                                                                                                                                                                                                                                                                                                          |
| `REQUIRE_APPROVAL`                          | _(unset)_                 | Default signup approval gate. Superadmins can override it at runtime in Admin → Users without redeploying; when no runtime override exists, this value is used. The first genuine human becomes superadmin regardless of this flag — see [First Login & Admin Access](/docs/guides/self-hosting/#first-login--admin-access).                                                                    |
| `TRIAL_ANONYMOUS_USER_ID`                   | `system_anonymous_trials` | Id of the internal anonymous-trial sentinel user, excluded from first-user superadmin checks. Override only if your deployment uses a different sentinel id.                                                                                                                                                                                                                                    |
| `CAPACITY_SIZE_FALLBACK_ENABLED`            | `true`                    | When a new node's VM size is exhausted on transient capacity, descend the size chain (large→medium→small). Only applies to default-derived sizes (project/platform default), never user-requested sizes. Set `false` to disable.                                                                                                                                                                |
| `ORIGIN_CA_CERT_VALIDITY_DAYS`              | `7`                       | Validity for per-node Cloudflare Origin CA certificates issued from node-generated CSRs. Must be one of Cloudflare's supported values: 7, 30, 90, 365, 730, 1095, or 5475.                                                                                                                                                                                                                      |

### Project file library cleanup

| Variable                                    | Default | Description                                                                                                                                          |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE` | `1000`  | Maximum project-owned library objects listed and deleted per R2 page after project deletion. Values above R2's 1,000-object page maximum are capped. |

### Deployment release and compose artifact retention

The scheduled Worker first reconciles provably stale non-terminal compose releases, then
prunes terminal deployment releases outside the protected window
(`apps/api/src/scheduled/d1-retention.ts:runDeploymentReleaseRetention()`). Terminal
retention always retains the newest releases per environment and the version reported in
`deployment_environments.observed_applied_seq`. The stale reconciler only marks a
`created`/`applying` compose-artifact release `failed` when D1 shows old release status
activity, stable authenticated deployment-node observed state, no recent release
fetch/apply events, a valid manifest, and a release version that is not the observed
applied version. Unknown statuses, malformed manifests, missing observed state, active
`applying` observations, and recent release events fail closed. Compose artifact cleanup
then re-derives references from the remaining manifests
(`apps/api/src/scheduled/compose-image-artifact-cleanup.ts:runComposeImageArtifactCleanup()`).

| Variable                                                 | Default                                | Description                                                                                           |
| -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DEPLOYMENT_RELEASE_RETENTION_ENABLED`                   | `true`                                 | Enables bounded terminal release pruning.                                                             |
| `DEPLOYMENT_RELEASE_RETENTION_COUNT`                     | `3`                                    | Newest releases protected per environment, in addition to observed-applied and non-terminal releases. |
| `DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE`                | `250`                                  | Maximum release rows deleted per run.                                                                 |
| `DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS`            | `24`                                   | Minimum interval between release retention runs.                                                      |
| `DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY`           | `cleanup:deployment-releases:last-run` | KV interval marker.                                                                                   |
| `DEPLOYMENT_RELEASE_RECONCILIATION_ENABLED`              | `true`                                 | Enables stale non-terminal compose release reconciliation before terminal retention.                  |
| `DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE`           | `50`                                   | Maximum stale non-terminal releases marked failed per retention run.                                  |
| `DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS`          | `168`                                  | Minimum release status age before reconciliation can terminalize a stale non-terminal release.        |
| `DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS` | `6`                                    | Recent release-event window that protects active fetch/apply work from reconciliation.                |
| `COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE`              | `250`                                  | Maximum abandoned compose archives deleted per daily run.                                             |

### R2 object lifecycle retention

Pulumi updates the existing assets bucket lifecycle resource on upgrades and creates
the same rules on clean installs (`infra/resources/storage.ts:r2BucketLifecycle`).
`temp-uploads/` is transient browser-upload staging; `tts/` is a regenerable audio
cache. Durable `library/` content is deleted only with its project, and reachable
`compose-image-artifacts/` are governed by deployment release retention. Archived
ProjectData tool payloads stay private and retrievable through Worker/MCP access
paths while message rows retain their text in the Durable Object, so these durable
prefixes do not have age-only lifecycle rules.

| Pulumi option               | Default | Object prefix                 | Description                                                        |
| --------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------ |
| `sessionSnapshotTtlDays`    | `7`     | `session-snapshots/`          | Worker-owned retention from actual sleep; no age-only R2 lifecycle |
| `diagnosticIncidentTtlDays` | `7`     | configured private            | Private diagnostic artifact retention                              |
| `tempUploadTtlDays`         | `1`     | `temp-uploads/`               | Abandoned presigned browser upload retention                       |
| `ttsTtlDays`                | `30`    | `tts/`                        | Regenerable TTS audio-cache retention                              |
| n/a                         | n/a     | `project-data/tool-payloads/` | Private ProjectData archive; Worker-owned retention only           |

All TTL options must be positive integers. Set overrides with `pulumi config set`
against the target stack before running its deployment workflow.

## Google OAuth and GCP provisioning

Google login and Google infrastructure authorization are independent credential families:

| Variables                                              | Purpose                    | Runtime precedence                                     | Redirect URIs                                              |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET` | BetterAuth user login      | `/setup` or superadmin runtime D1 → Worker env → unset | `/api/auth/callback/google`                                |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`             | Keyless GCP/WIF setup only | Superadmin runtime D1 → Worker env → unset             | `/auth/google/callback` and `/api/deployment/gcp/callback` |

Configuring one family never enables or modifies the other. Users who choose service-account JSON do not need either infrastructure OAuth variable.

| Variable                             | Default                                          | Description                                                                                 |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES` | `65536`                                          | Maximum UTF-8 byte size accepted by `PUT /api/gcp/service-account`                          |
| `GCP_DEFAULT_ZONE`                   | `us-central1-a`                                  | Default Compute zone                                                                        |
| `GCP_IMAGE_FAMILY`                   | `ubuntu-2404-lts-amd64`                          | Compute image family                                                                        |
| `GCP_IMAGE_PROJECT`                  | `ubuntu-os-cloud`                                | Compute image project                                                                       |
| `GCP_DISK_SIZE_GB`                   | `50`                                             | Boot disk size                                                                              |
| `GCP_TOKEN_CACHE_TTL_SECONDS`        | `3300`                                           | Maximum derivative access-token cache TTL; actual TTL is capped by Google's returned expiry |
| `GCP_IDENTITY_TOKEN_EXPIRY_SECONDS`  | `600`                                            | SAM identity-token lifetime for WIF                                                         |
| `GCP_OPERATION_POLL_TIMEOUT_MS`      | `300000`                                         | Maximum wait for GCP asynchronous operations                                                |
| `GCP_API_TIMEOUT_MS`                 | `30000`                                          | GCP OAuth, IAM, and Compute request timeout                                                 |
| `GCP_STS_SCOPE`                      | `https://www.googleapis.com/auth/cloud-platform` | WIF STS exchange scope                                                                      |
| `GCP_SA_IMPERSONATION_SCOPES`        | `https://www.googleapis.com/auth/compute`        | Comma-separated scopes for WIF service-account impersonation                                |
| `GCP_SA_TOKEN_LIFETIME_SECONDS`      | `3600`                                           | WIF impersonated access-token lifetime                                                      |
| `GCP_STS_TOKEN_URL`                  | `https://sts.googleapis.com/v1/token`            | WIF STS endpoint override for controlled environments                                       |
| `GCP_IAM_CREDENTIALS_BASE_URL`       | Google IAM Credentials API                       | WIF impersonation base URL override                                                         |

The service-account JWT bearer flow always uses `https://oauth2.googleapis.com/token`; it has no endpoint override, and uploaded `token_uri` values are ignored. Source credentials are encrypted in D1. Only derivative short-lived tokens are cached.

## AI Idea Title Generation

| Variable                                 | Default               | Description                                      |
| ---------------------------------------- | --------------------- | ------------------------------------------------ |
| `TASK_TITLE_MODEL`                       | `@cf/zai-org/glm-5.2` | Workers AI model for title generation            |
| `TASK_TITLE_MAX_LENGTH`                  | `100`                 | Max characters in generated title                |
| `TASK_TITLE_TIMEOUT_MS`                  | `5000`                | Timeout before falling back to truncation        |
| `TASK_TITLE_GENERATION_ENABLED`          | `true`                | Set `false` to disable AI generation             |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD`     | `100`                 | Messages at or below this length bypass AI       |
| `TASK_TITLE_MAX_RETRIES`                 | `2`                   | Max retry attempts on failure                    |
| `TASK_TITLE_RETRY_DELAY_MS`              | `1000`                | Base delay between retries (exponential backoff) |
| `TASK_TITLE_RETRY_MAX_DELAY_MS`          | `4000`                | Max delay cap for backoff                        |
| `TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH` | `512`                 | Max sanitized provider-error diagnostic length   |

## Task Output Branches

| Variable             | Default | Description                                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `BRANCH_NAME_PREFIX` | `sam/`  | Prefix for generated task output branches. Include the trailing separator (for example `agent/`). |

Task workspaces are checked out on the generated output branch, and SAM refuses to auto-push a completed task while the workspace is still on the project's default branch. See [Where the work lands](/docs/guides/idea-execution/#where-the-work-lands).

## Deployment Debugging Agent

| Variable                          | Default               | Description                                            |
| --------------------------------- | --------------------- | ------------------------------------------------------ |
| `DEBUG_AGENT_MODEL`               | `@cf/zai-org/glm-5.2` | Workers AI model for superadmin deployment diagnosis   |
| `DEBUG_AGENT_MAX_TURNS`           | `6`                   | Maximum model/tool turns per diagnosis                 |
| `DEBUG_AGENT_RUN_TOKEN_LIMIT`     | `96000`               | Combined token ceiling per diagnosis                   |
| `DEBUG_AGENT_MODEL_OUTPUT_TOKENS` | `4096`                | Maximum output tokens requested per model turn         |
| `DEBUG_AGENT_DAILY_TOKEN_LIMIT`   | `480000`              | Daily diagnosis token budget, counted **per feature**  |
| `DEBUG_AGENT_TOOL_RESULT_LIMIT`   | `50`                  | Maximum rows returned by a diagnosis tool              |
| `DEBUG_AGENT_TOOL_RESULT_BYTES`   | `32768`               | Maximum serialized bytes per model-visible tool result |
| `DEBUG_AGENT_MAX_WINDOW_HOURS`    | `24`                  | Maximum selectable diagnosis window                    |
| `DEBUG_AGENT_TIMEOUT_MS`          | `120000`              | Timeout for each diagnosis model request               |
| `DEBUG_AGENT_HARD_DEADLINE_MS`    | `900000`              | Hard deadline for an active diagnosis                  |
| `DEBUG_AGENT_STALE_HEARTBEAT_MS`  | `120000`              | Orphan reconciler heartbeat threshold                  |
| `DEBUG_AGENT_RETRY_BASE_DELAY_MS` | `2000`                | Initial transient step retry delay                     |
| `DEBUG_AGENT_RETRY_MAX_DELAY_MS`  | `60000`               | Maximum transient step retry delay                     |
| `DEBUG_AGENT_STEP_MAX_RETRIES`    | `3`                   | Maximum classified transient retries per step          |

The `/admin/errors` view remains superadmin-only and may show local user IDs, IP addresses, and user-agent strings. Before any tool result enters model context, SAM recursively removes those fields plus credential-shaped values such as API tokens, JWTs, authorization headers, private keys, and long secret-like strings. Cloudflare credentials stay server-side and are never included in model messages or saved diagnosis text.

### Same-installation VM diagnostic evidence

VM failures use a durable local SQLite outbox and a private R2 artifact. Generated deployments set the R2 prefix and object lifecycle from Pulumi; the remaining Worker bounds can be overridden through deployment environment variables.

| Worker variable                             | Default                | Description                                                          |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `MAX_VM_AGENT_ERROR_BODY_BYTES`             | `32768`                | Maximum VM error batch body                                          |
| `MAX_VM_AGENT_ERROR_BATCH_SIZE`             | `10`                   | Maximum errors per VM batch                                          |
| `MAX_VM_AGENT_ERROR_SOURCE_LENGTH`          | `256`                  | Maximum redacted VM error source length                              |
| `OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH`    | `2048`                 | Maximum persisted observability error message length                 |
| `OBSERVABILITY_ERROR_STACK_MAX_LENGTH`      | `4096`                 | Maximum persisted observability stack length                         |
| `OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH` | `512`                  | Maximum persisted observability user-agent length                    |
| `VM_INCIDENT_R2_PREFIX`                     | `diagnostic-incidents` | Private object prefix; generated from the Pulumi output              |
| `VM_INCIDENT_ARTIFACT_MAX_BYTES`            | `2097152`              | Maximum compressed artifact size                                     |
| `VM_INCIDENT_REGISTRATION_MAX_BYTES`        | `262144`               | Maximum registration JSON body                                       |
| `VM_INCIDENT_MANIFEST_MAX_BYTES`            | `131072`               | Maximum redacted manifest                                            |
| `VM_INCIDENT_PREVIEW_MAX_BYTES`             | `131072`               | Maximum redacted model/UI preview                                    |
| `VM_INCIDENT_MAX_ARTIFACTS_PER_NODE`        | `50`                   | Active artifact quota per node                                       |
| `VM_INCIDENT_MAX_BYTES_PER_NODE`            | `104857600`            | Active expected-byte quota per node                                  |
| `VM_INCIDENT_RETENTION_DAYS`                | `7`                    | Private object and active metadata retention                         |
| `VM_INCIDENT_METADATA_RETENTION_DAYS`       | `30`                   | Expired metadata retention after object deletion                     |
| `VM_INCIDENT_PENDING_TIMEOUT_MINUTES`       | `30`                   | Incomplete-upload timeout and upload-lease duration                  |
| `VM_INCIDENT_RECONCILE_BATCH_SIZE`          | `50`                   | Maximum artifacts/incidents repaired per scheduled pass (minimum: 6) |

The VM Agent process accepts the corresponding `ERROR_REPORT_*` overrides for flush interval, batch size/bytes, outbox size and path, SQLite busy timeout, HTTP timeout, retry bounds, attempts, spool path/bytes, artifact bytes, retention, collector timeout/count/concurrency, document bytes, recursive value depth/items, string bytes, structured event limit, response-read bytes, and persisted-error bytes. Generated deployments pass these validated values through cloud-init into the VM Agent systemd service, so overrides apply to newly provisioned nodes. Defaults are listed in `apps/api/.env.example`; the common defaults are a 32 KiB error batch, 1,000-row outbox, 2 MiB artifact, 20 MiB spool, and 24-hour local retention.

Pulumi options `diagnosticIncidentPrefix` (default `diagnostic-incidents`) and `diagnosticIncidentTtlDays` (default `7`, any positive integer) configure the private prefix and an independent R2 lifecycle rule. They do not require a separate bucket or manually managed Worker variable. The prefix cannot begin with the application-owned namespaces `agents`, `cli`, `compose-image-artifacts`, `library`, `session-snapshots`, `temp-uploads`, or `tts`, because the lifecycle would otherwise expire unrelated objects.

### Platform Feedback Triage

| Variable                                                       | Default      | Description                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_FEEDBACK_PROJECT_ID`                                 | unset        | Bootstrap/environment fallback for the project that receives user issue reports and automated triage draft Ideas. The Admin → Integrations runtime setting is preferred and overrides it. |
| `PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES`                      | `60`         | Lookback window for grouping recent platform errors                                                                                                                                       |
| `PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT`                         | `100`        | Maximum platform error rows scanned per triage sweep                                                                                                                                      |
| `PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT`                         | `5`          | Maximum grouped feedback candidates processed per triage sweep                                                                                                                            |
| `PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT`                      | `10`         | Maximum bounded error references retained per grouped feedback record                                                                                                                     |
| `PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS`                        | `600000`     | Claim lease duration before a later sweep can reclaim the group                                                                                                                           |
| `PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES`                        | `3`          | Maximum failed attempts before a group is rejected from auto-triage                                                                                                                       |
| `PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH`           | `240`        | Maximum characters stored or returned for sanitized failure reasons                                                                                                                       |
| `PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS`                     | `86400000`   | Retry delay for per-run budget deferrals                                                                                                                                                  |
| `PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS`             | `7200000`    | Dispatch lease before a failed incident trigger handoff can be reclaimed                                                                                                                  |
| `PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS`                | `3600000`    | Agent claim lease before another task can reclaim a private incident                                                                                                                      |
| `PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS`             | `3`          | Agent-reported failed dispatch attempts before an incident is rejected                                                                                                                    |
| `PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS`                | `1800000`    | Minimum elapsed time after terminal resolution/expiry before a newer occurrence can reopen the same signature; set `0` to disable cooldown-only suppression                               |
| `PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT`                     | `25`         | Maximum expired dispatch leases reclaimed by one incident sweep                                                                                                                           |
| `PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS`                        | `2592000000` | Maximum active incident age before expiry                                                                                                                                                 |
| `PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS`        | `259200000`  | Maximum age for one-off pending incidents with no recurrence                                                                                                                              |
| `PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE` | `25`         | Maximum stale singleton incidents expired per sweep                                                                                                                                       |
| `PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY`             | `error`      | Minimum severity admitted to automatic VM incident dispatch                                                                                                                               |
| `PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE`           | `2`          | Dispatch immediately once this many eligible incidents are ready                                                                                                                          |
| `PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS`                | `1800000`    | Dispatch a smaller eligible batch after this pending age                                                                                                                                  |
| `PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS`           | `3600000`    | Rate-cap window for each incident trigger                                                                                                                                                 |
| `PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW` | `1`          | Maximum dispatches one incident trigger may submit per rate window                                                                                                                        |
| `PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED`              | `true`       | Auto-create one private incident trigger when pending incidents exist and no incident trigger exists                                                                                      |
| `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT`                     | `5`          | Maximum active incident triggers inspected per sweep                                                                                                                                      |
| `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME`                      | built-in     | Name for the auto-created private incident trigger                                                                                                                                        |
| `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE`                  | built-in     | Prompt template for the auto-created private incident trigger                                                                                                                             |
| `PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT`                     | `10`         | Maximum grouped incidents included in one incident-trigger backlog summary                                                                                                                |
| `PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT`                | `10`         | Maximum bounded evidence references retained per incident                                                                                                                                 |
| `PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES`                | `32768`      | Maximum serialized evidence bytes retained per incident                                                                                                                                   |
| `PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH`        | `2000`       | Maximum private incident resolution-note length                                                                                                                                           |

Resolved and expired incident signatures reopen only when a newer occurrence arrives after `PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS`; older lookback-window occurrences remain closed. VM-agent incidents resolved with fix evidence also wait for occurrences from nodes reporting the current `VM_AGENT_REQUIRED_VERSION`, because Worker deploys do not update already-running VM binaries. Dispatch attempts are consumed only when the incident task reports its own failure; platform-side handoff/session failures release the dispatch without incrementing `dispatch_attempts`.

Automated triage and superadmin-initiated diagnosis read the same `DEBUG_AGENT_DAILY_TOKEN_LIMIT` value but count against **independent per-feature counters**, so worst-case daily spend across both is twice this value. Automated triage treats budget exhaustion as a retryable deferral: daily exhaustion retries after the next UTC day starts, and per-run exhaustion uses `PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS`. Incident trigger agents run from the private grouped backlog and dispatch one agent for a bounded backlog summary, not one agent per occurrence. Automatic incident dispatch ignores pending signatures already linked to open tracked work and warning-only signatures below the configured severity floor, then applies the batch/age gate and per-trigger rate cap before reserving incidents.

### Report an Issue

The in-app **Report an Issue** flow files user-submitted reports as draft Ideas in the effective private feedback project. Configure it from **Admin → Integrations** when possible; `PLATFORM_FEEDBACK_PROJECT_ID` remains the environment fallback when no runtime setting is saved. The feature is **hidden entirely** — both UI entry points disappear and `GET /api/report-issue/config` returns `enabled: false` — when no effective project exists or the effective project does not exist in this deployment's database.

| Variable                              | Default | Description                                                       |
| ------------------------------------- | ------- | ----------------------------------------------------------------- |
| `REPORT_ISSUE_TITLE_MAX_LENGTH`       | `200`   | Truncation ceiling for the stored title (lowers only — see below) |
| `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH` | `5000`  | Truncation ceiling for the stored description (lowers only)       |
| `REPORT_ISSUE_CONTENT_MAX_LENGTH`     | `65536` | Maximum stored Idea body, including attached technical references |
| `RATE_LIMIT_REPORT_ISSUE_POST`        | `20`    | Report submissions allowed per clock hour, per authenticated user |

The two length variables apply **after** request validation, so they can only lower the stored length — the request schema and the report dialog both enforce the built-in 200 / 5,000 caps regardless of what you set here.

See [Reporting Issues](/docs/guides/reporting-issues/) for the user-facing flow and the untrusted-evidence Idea format.

## Agent Model Catalog

SAM loads OpenCode Zen and OpenCode Go model choices through the authenticated model-catalog API, backed by Models.dev and cached in KV. If the upstream catalog or cache is unavailable, SAM falls back to the static catalog shipped with the app.

| Variable                          | Default                       | Description                                                   |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `MODEL_CATALOG_SOURCE_URL`        | `https://models.dev/api.json` | Source URL for the dynamic model catalog                      |
| `MODEL_CATALOG_CACHE_TTL_SECONDS` | `3600`                        | KV cache TTL for normalized dynamic model catalog payloads    |
| `MODEL_CATALOG_FETCH_TIMEOUT_MS`  | `5000`                        | Timeout for the upstream catalog fetch before static fallback |

## HTTP Response Caching

Conservative `Cache-Control` budgets for stable and semi-stable API `GET`s, letting the browser
serve a cached body instantly while it revalidates in the background. All values are **seconds** and
are clamped to `[0, 86400]`; an unparseable or negative value falls back to the default rather than
caching for longer.

Authenticated responses are always emitted as `private` with `Vary: Cookie`, so neither a shared
cache nor a second account in the same browser can be served another user's body. Only the
unauthenticated `/api/config/*` endpoints are marked `public`. Endpoints returning real-time data
(chat messages, task status, session and workspace state) are deliberately excluded.

| Variable                                  | Default | Description                                                                 |
| ----------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS`     | `60`    | `max-age` for the unauthenticated `/api/config/*` endpoints                 |
| `PUBLIC_CONFIG_CACHE_SWR_SECONDS`         | `300`   | `stale-while-revalidate` for `/api/config/*`                                |
| `MODEL_CATALOG_CACHE_MAX_AGE_SECONDS`     | `60`    | `max-age` for `GET /api/model-catalog/:agentType`                           |
| `MODEL_CATALOG_CACHE_SWR_SECONDS`         | `300`   | `stale-while-revalidate` for the model catalog response                     |
| `PROJECT_REFERENCE_CACHE_MAX_AGE_SECONDS` | `0`     | `max-age` for project agent-profile and skill lists (0 = always revalidate) |
| `PROJECT_REFERENCE_CACHE_SWR_SECONDS`     | `30`    | `stale-while-revalidate` for project agent-profile and skill lists          |

## Warm Node Pooling

| Variable                               | Default            | Description                                                                                                                      |
| -------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_WARM_TIMEOUT_MS`                 | `1800000` (30 min) | Time a node stays warm after idea execution completes                                                                            |
| `MAX_AUTO_NODE_LIFETIME_MS`            | `14400000` (4 hr)  | Max lifetime for an auto-provisioned node holding no active workspaces                                                           |
| `NODE_WARM_GRACE_PERIOD_MS`            | `2100000` (35 min) | Cron sweep grace period (must be > warm timeout)                                                                                 |
| `NODE_LIFECYCLE_ALARM_RETRY_MS`        | `60000` (1 min)    | Retry delay for DO alarm failures                                                                                                |
| `NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS` | `86400000` (24 hr) | Backstop after which a destroying-state alarm self-cleans; infrastructure teardown remains owned by cron/provider reconciliation |
| `DEFAULT_TASK_AGENT_TYPE`              | `opencode`         | Default agent for autonomous idea execution                                                                                      |

## Idle & Orphan Node Reaping

The cleanup sweep measures idleness from a node's last **workspace activity**
(`COALESCE(MAX(workspaces.updated_at), nodes.created_at)`), never from
`nodes.updated_at` — heartbeats rewrite `updated_at` on every beat, so it tracks
liveness rather than idleness.

Reaping only ever applies to nodes with `node_role = 'workspace'` and
`node_class != 'user-owned'`. Deployment nodes host long-running user applications
and legitimately hold zero workspaces forever, so they are never reaped by these
timers; they are released when their last deployment environment is deleted.

| Variable                                   | Default            | Description                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ORPHAN_IDLE_TIMEOUT_MS`              | `2700000` (45 min) | Idle window before a running workspace node with no active workspaces is destroyed, and minimum pre-heartbeat grace before an unversioned, unclaimed workspace VM can be retired. Keep above `NODE_WARM_TIMEOUT_MS` so the warm path reclaims reusable nodes first. |
| `NODE_ABSOLUTE_MAX_LIFETIME_MS`            | `86400000` (24 hr) | Hard ceiling on auto-provisioned workspace node age. Applies even when a workspace row still reports `running`, provided no workspace has reported activity within the idle window — this is what stops a stuck workspace row from making a node immortal.          |
| `NODE_CLEANUP_SWEEP_LIMIT`                 | `25`               | Max node candidates processed per cleanup phase per cron run.                                                                                                                                                                                                       |
| `NODE_CLEANUP_FAILURE_BACKOFF_MS`          | `3600000` (1 hr)   | Expiring exclusion applied to failed cleanup candidates so a permanent provider error cannot monopolize the bounded page.                                                                                                                                           |
| `WORKSPACE_CLEANUP_SWEEP_LIMIT`            | `50`               | Max workspace candidates processed per cleanup phase per cron run.                                                                                                                                                                                                  |
| `NODE_AGENT_BACKGROUND_REQUEST_TIMEOUT_MS` | `5000` (5 s)       | VM-agent request timeout for background sweeps. Deliberately far below the interactive `NODE_AGENT_REQUEST_TIMEOUT_MS` (30 s) so a sweep over unreachable nodes cannot exhaust the Worker's wall-clock budget.                                                      |

## Operational Control-Loop Safety

The cron and Durable Object switches are availability brakes: an absent key or
KV read error means **enabled** (fail-open). This differs deliberately from the
fail-closed trials entitlement switch. Superadmins can inspect and update both
brakes through `/api/admin/runtime-controls`; emergency operators can use the
KV procedure in `.claude/rules/55-runaway-cost-emergency-ops.md`.

| Variable                                | Default                        | Description                                                                                |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `CRON_SWEEPS_ENABLED_KV_KEY`            | `control-loops:cron-enabled`   | KV key gating the five-minute operational sweep block                                      |
| `DO_ALARMS_ENABLED_KV_KEY`              | `control-loops:alarms-enabled` | Shared KV key gating alarm-bearing Durable Objects                                         |
| `CONTROL_LOOP_KILL_SWITCH_CACHE_MS`     | `30000`                        | In-memory switch cache; runtime clamps it to at most 30 seconds                            |
| `CONTROL_LOOP_DISABLED_ALARM_RETRY_MS`  | `300000` (5 min)               | Safe alarm recheck interval while DO work is disabled; values below 60 seconds are clamped |
| `CRON_FAILURE_NOTIFICATION_THROTTLE_MS` | `3600000` (1 hr)               | Per-sweep throttle enforced by a KV cache plus an atomic per-user Notification DO claim    |
| `CRON_FAILURE_NOTIFICATION_KV_PREFIX`   | `cron-failure-notification`    | KV prefix for notification throttle markers                                                |
| `DIAGNOSIS_COMPLETED_STEP_MIN_DELAY_MS` | `1000`                         | Minimum delayed re-arm for an already-completed diagnosis step                             |
| `ORCHESTRATOR_ZERO_TASK_GRACE_MS`       | `600000` (10 min)              | Grace period before an active mission with no tasks terminalizes                           |
| `ORCHESTRATOR_MAX_MISSION_LIFETIME_MS`  | `86400000` (24 hr)             | Backstop that force-completes active/completing missions                                   |

The scheduled Durable Object billing monitor reads these non-secret variables
from the selected GitHub Environment, not from the API Worker runtime:

| Variable                              | Default/fallback                                | Description                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `DO_WALL_TIME_SCRIPT_NAMES`           | none                                            | Optional comma-separated API Worker filter for wall-time and invocation-rate analysis                                                           |
| `DO_INVOCATION_RATE_REGRESSION_RATIO` | `2`                                             | Recent-versus-seven-day-baseline request-rate failure ratio                                                                                     |
| `DO_CRON_LIVENESS_MAX_AGE_HOURS`      | `3`                                             | Maximum age of the most recent targeted `cron.completed` event                                                                                  |
| `DO_CRON_LIVENESS_SCRIPT_NAMES`       | `DO_WALL_TIME_SCRIPT_NAMES`                     | Explicit API Worker service target for cron liveness; the GitHub workflow derives both from `RESOURCE_PREFIX` and the selected stack when unset |
| `DO_CRON_LIVENESS_ENDPOINT`           | Cloudflare Workers Observability query endpoint | Optional endpoint override for compatible/private telemetry gateways                                                                            |

The selected GitHub Environment's `CF_API_TOKEN` secret must include the
Cloudflare **Workers Observability Write** permission. Cloudflare requires that
permission for the telemetry query endpoint even though this monitor only reads
aggregated liveness telemetry.

## Provider-Side Orphan Reconciliation

Reclaims cloud servers that exist at the provider but which no live database row
claims — for example when a server was created but the control plane failed before
recording its instance ID.

Because this is the only path that destroys infrastructure on the basis of _absent_
evidence, it fails closed at every step. A server must carry both the current
control-plane `env` value and the exact Pulumi-generated `installation` marker before
SAM consults D1. SAM then re-reads and revalidates the same provider resource immediately
before it calls the provider delete API. Provider-account membership, server
names, resource prefixes, and absence from this installation's D1 are not ownership
proof.

Pulumi generates the non-secret installation identity automatically on first deploy,
persists it in the stack state, and injects it into the Worker as
`SAM_INSTALLATION_ID`; there is no manual GitHub Environment setting. An upgrade does
not relabel existing servers. Legacy servers without the marker remain usable and are
preserved indefinitely, while servers provisioned after the upgrade participate in
normal orphan cleanup. If the Pulumi state is lost or recreated, the new identity
safely leaves the old fleet unattributable instead of adopting it destructively. Any
missing/malformed identity, ambiguous provider metadata, or failed/malformed D1 lookup
skips deletion. Resources surfaced to reconciliation with non-owning metadata emit
aggregate operator-visible counters.

| Variable                                 | Default          | Description                                                                                                                                                                       |
| ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_ORPHAN_RECONCILIATION_ENABLED` | `true`           | Set to `false` to disable provider-side reconciliation entirely.                                                                                                                  |
| `PROVIDER_ORPHAN_MIN_AGE_MS`             | `3600000` (1 hr) | Minimum server age before it can be treated as an orphan. Must comfortably exceed provisioning time, since a server's instance ID is recorded only after the provider returns it. |
| `PROVIDER_ORPHAN_DESTROY_LIMIT`          | `5`              | Max servers destroyed per reconciliation run.                                                                                                                                     |
| `PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS`  | `3600000` (1 hr) | Minimum interval between runs. Invoked by the 5-minute cron but self-throttled to this interval via KV.                                                                           |

## Project Invites

| Variable                               | Default | Description                                                                |
| -------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `PROJECT_INVITE_TOKEN_BYTES`           | `32`    | Random bytes used for generated project invite link tokens                 |
| `PROJECT_INVITE_DEFAULT_EXPIRY_DAYS`   | `7`     | Default lifetime for invite links created without an explicit expiry       |
| `PROJECT_INVITE_MAX_EXPIRY_DAYS`       | `30`    | Maximum allowed invite link lifetime, including explicit expiry-date input |
| `PROJECT_OFFBOARDING_PLAN_TTL_SECONDS` | `900`   | Lifetime for project member offboarding preview plans before recomputation |

## Notification System

| Variable                                | Default                | Description                                                            |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` | `300000` (5 min)       | Min interval between progress notifications per idea                   |
| `NOTIFICATION_DEDUP_WINDOW_MS`          | `60000` (60s)          | Dedup window for task_complete notifications                           |
| `NOTIFICATION_AUTO_DELETE_AGE_MS`       | `7776000000` (90 days) | Auto-delete old notifications                                          |
| `MAX_NOTIFICATIONS_PER_USER`            | `500`                  | Max stored notifications per user                                      |
| `NOTIFICATION_PAGE_SIZE`                | `50`                   | Default page size for notification list                                |
| `MAX_NOTIFICATION_PAGE_SIZE`            | `100`                  | Max allowed page size                                                  |
| `HUMAN_INPUT_TIMEOUT_MS`                | `7200000` (2 hr)       | Initial needs-input response window                                    |
| `HUMAN_INPUT_ESCALATION_FRACTIONS`      | `0.25,0.75`            | Reminder points within the initial response window                     |
| `HUMAN_INPUT_UNDELIVERED_GRACE_MS`      | `7200000` (2 hr)       | Extension without confirmed push delivery                              |
| `HUMAN_INPUT_MAX_WAIT_MS`               | `86400000` (24 hr)     | Hard maximum needs-input marker lifetime                               |
| `WEB_PUSH_TTL_SECONDS`                  | `86400`                | Push-service message TTL                                               |
| `WEB_PUSH_VAPID_TTL_SECONDS`            | `43200`                | VAPID authorization-token lifetime                                     |
| `WEB_PUSH_DELIVERY_TIMEOUT_MS`          | `10000`                | Per-attempt push-service timeout                                       |
| `WEB_PUSH_DELIVERY_BUDGET_MS`           | `25000`                | Total fan-out budget, hard-capped at 25s below Worker background limit |
| `WEB_PUSH_FANOUT_CONCURRENCY`           | `8`                    | Maximum concurrent endpoint deliveries                                 |
| `WEB_PUSH_MAX_ATTEMPTS`                 | `3`                    | Bounded transient delivery attempts                                    |
| `WEB_PUSH_MAX_RETRY_AFTER_SECONDS`      | `30`                   | Maximum honored Retry-After delay                                      |
| `WEB_PUSH_MAX_PAYLOAD_BYTES`            | `3500`                 | Maximum unencrypted payload size                                       |
| `WEB_PUSH_FAILURE_THRESHOLD`            | `5`                    | Consecutive failures before disabling a subscription                   |
| `WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER`   | `8`                    | Maximum retained browser endpoints per user                            |
| `WEB_PUSH_USER_AGENT_MAX_LENGTH`        | `512`                  | Maximum stored browser description length                              |
| `RATE_LIMIT_PUSH_SUBSCRIPTION`          | `30`                   | Subscription mutations per user per hour                               |

## Event Trigger Cleanup

| Variable                                     | Default            | Description                                                                                                      |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `TRIGGER_STALE_EXECUTION_TIMEOUT_MS`         | `1800000` (30 min) | Age before running executions are checked against linked task liveness                                           |
| `TRIGGER_STALE_QUEUED_TIMEOUT_MS`            | `300000` (5 min)   | Age before queued executions are checked against linked task liveness                                            |
| `TRIGGER_EXECUTION_HARD_MAX_RESIDENCE_HOURS` | `48`               | Hard maximum execution residence backstop; live linked tasks still control concurrency and incident dispatch use |
| `TRIGGER_EXECUTION_LOG_RETENTION_DAYS`       | `90`               | Completed/failed/skipped execution log retention                                                                 |
| `TRIGGER_EXECUTION_CLEANUP_ENABLED`          | enabled            | Set to `false` to disable the cleanup sweep                                                                      |
| `TRIGGER_STALE_RECOVERY_BATCH_SIZE`          | `100`              | Maximum stale execution candidates processed per sweep                                                           |

## Generic Webhook Triggers

| Variable                                      | Default | Description                                                 |
| --------------------------------------------- | ------- | ----------------------------------------------------------- |
| `WEBHOOK_TRIGGERS_ENABLED`                    | `true`  | Public generic webhook ingress kill switch                  |
| `WEBHOOK_TRIGGER_MAX_BODY_BYTES`              | `65536` | Maximum JSON request body size                              |
| `WEBHOOK_TRIGGER_MAX_FILTERS`                 | `10`    | Maximum deterministic filters per trigger                   |
| `WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH`      | `200`   | Maximum configured filter dot-path length                   |
| `WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH`       | `8`     | Maximum filter nesting depth at evaluation time             |
| `WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS`        | `10`    | Maximum safe request headers copied into template context   |
| `WEBHOOK_TRIGGER_MAX_HEADER_NAME_LENGTH`      | `100`   | Maximum configured included-header name length              |
| `WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH`     | `100`   | Maximum optional source label length                        |
| `WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH`  | `200`   | Maximum accepted `Idempotency-Key` length                   |
| `WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE`       | `120`   | Best-effort pre-auth request damping per client IP/window   |
| `WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE`       | `60`    | Best-effort request damping per trigger/window              |
| `WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE` | `30`    | Best-effort invalid-token damping per client IP/window      |
| `WEBHOOK_RATE_LIMIT_WINDOW_SECONDS`           | `60`    | Fixed rate-limit window length                              |
| `WEBHOOK_DELIVERY_RETENTION_DAYS`             | `7`     | Retention for redacted delivery audit metadata              |
| `WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE`         | `500`   | Maximum expired audit rows deleted per cleanup pass         |
| `WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE`          | `25`    | Default delivery-history page size                          |
| `WEBHOOK_DELIVERY_MAX_PAGE_SIZE`              | `100`   | Maximum delivery-history page size                          |
| `WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS`   | `300`   | Lease before an unsubmitted processing delivery can recover |

Webhook tokens use the existing `ENCRYPTION_KEY` as keyed-hash material and do not require a separate deployment secret. See [Webhook Triggers](/docs/guides/webhook-triggers/) for request, credential, filtering, and audit behavior.

Webhook damping uses Cloudflare KV's eventually consistent read-update-write behavior. It reduces accidental bursts and abuse but is not a strict distributed quota.

## ACP Session Lifecycle

| Variable                                | Default          | Description                                                                                                                                                                                                    |
| --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACP_SESSION_DETECTION_WINDOW_MS`       | `300000` (5 min) | Stale ProjectData ACP heartbeat detection window. VM sessions are not interrupted solely from stale/missing ProjectData heartbeat rows; the timeout must be paired with conclusive runtime/workspace evidence. |
| `ACP_SESSION_HEARTBEAT_INTERVAL_MS`     | `60000` (60s)    | How often VM agent sends heartbeats                                                                                                                                                                            |
| `ACP_SESSION_RECONCILIATION_TIMEOUT_MS` | `30000` (30s)    | VM agent startup reconciliation timeout                                                                                                                                                                        |
| `ACP_SESSION_MAX_FORK_DEPTH`            | `10`             | Maximum session fork chain depth                                                                                                                                                                               |
| `ACP_SESSION_FORK_CONTEXT_MESSAGES`     | `20`             | Context messages included when forking                                                                                                                                                                         |

## ACP Protocol (VM Agent)

| Variable                               | Default | Description                                                      |
| -------------------------------------- | ------- | ---------------------------------------------------------------- |
| `ACP_MESSAGE_BUFFER_SIZE`              | `5000`  | Buffer size for ACP messages                                     |
| `ACP_STDERR_BUFFER_BYTES`              | `4096`  | Agent stderr bytes retained for crash reports                    |
| `ACP_PING_INTERVAL`                    | `30s`   | WebSocket keepalive ping interval                                |
| `ACP_PONG_TIMEOUT`                     | `10s`   | Pong response timeout                                            |
| `ACP_TASK_PROMPT_TIMEOUT`              | `8h`    | Task execution prompt timeout                                    |
| `ACP_PROMPT_RETRY_MAX_RETRIES`         | `2`     | Max transient provider prompt retries after the initial attempt  |
| `ACP_PROMPT_RETRY_INITIAL_BACKOFF`     | `15s`   | Initial backoff before retrying transient provider prompt errors |
| `ACP_PROMPT_RETRY_MAX_BACKOFF`         | `2m`    | Max exponential backoff for transient provider prompt retries    |
| `ACTIVITY_REREPORT_INTERVAL`           | `60s`   | Re-send prompting activity while a prompt is active              |
| `ACP_HARNESS_ACTIVITY_REPORT_DEBOUNCE` | `750ms` | Debounce ACP harness/tool-call activity reports before callbacks |
| `ACP_CHECKPOINT_PREEMPT_GRACE`         | `30s`   | Graceful ACP cancel/close wait before harness force-stop         |
| `ACP_CHECKPOINT_PREEMPT_MAX_GRACE`     | `2m`    | Maximum caller-selected checkpoint rollover grace                |
| `ACP_CHECKPOINT_ROLLOVER_TIMEOUT`      | `2m`    | Full checkpoint restart and strict LoadSession deadline          |
| `ACTIVITY_TERMINAL_REPORT_ATTEMPTS`    | `5`     | Retry attempts for terminal activity reports                     |
| `ACTIVITY_TERMINAL_REPORT_BACKOFF`     | `1s`    | Backoff between terminal activity report retries                 |
| `ACP_IDLE_SUSPEND_TIMEOUT`             | `30m`   | Idle session auto-suspend timeout                                |
| `ACP_NOTIF_SERIALIZE_TIMEOUT`          | `5s`    | Notification serialization timeout                               |

## MCP (Agent Tools)

| Variable                              | Default           | Description                                     |
| ------------------------------------- | ----------------- | ----------------------------------------------- |
| `MCP_TOKEN_TTL_SECONDS`               | `28800` (8 hours) | Sliding inactivity timeout for agent MCP access |
| `MCP_RATE_LIMIT`                      | `120`             | Max MCP requests per window                     |
| `MCP_RATE_LIMIT_WINDOW_SECONDS`       | `60`              | Rate limit window                               |
| `MCP_DISPATCH_MAX_DEPTH`              | `3`               | Max recursion depth for dispatch_task           |
| `MCP_DISPATCH_MAX_PER_TASK`           | `5`               | Max dispatched tasks per parent task            |
| `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` | `10`              | Max active dispatched tasks per project         |
| `ORCHESTRATOR_STOP_CAS_MAX_ATTEMPTS`  | `2`               | Task-status CAS attempts after a hard stop      |

## Voice & Text-to-Speech

| Variable                     | Default                             | Description                      |
| ---------------------------- | ----------------------------------- | -------------------------------- |
| `WHISPER_MODEL_ID`           | `@cf/openai/whisper-large-v3-turbo` | Transcription model              |
| `MAX_AUDIO_SIZE_BYTES`       | `10485760` (10 MB)                  | Max upload audio size            |
| `MAX_AUDIO_DURATION_SECONDS` | `60`                                | Max recording duration           |
| `RATE_LIMIT_TRANSCRIBE`      | `30`                                | Max transcriptions per minute    |
| `TTS_ENABLED`                | `true`                              | Enable/disable text-to-speech    |
| `TTS_MODEL`                  | `@cf/deepgram/aura-2-en`            | TTS model                        |
| `TTS_SPEAKER`                | `luna`                              | TTS voice selection              |
| `TTS_ENCODING`               | `mp3`                               | Audio output format              |
| `TTS_MAX_TEXT_LENGTH`        | `100000`                            | Max characters per TTS synthesis |
| `TTS_TIMEOUT_MS`             | `60000`                             | TTS synthesis timeout            |

## Context Summarization (Forking)

| Variable                          | Default                         | Description                                  |
| --------------------------------- | ------------------------------- | -------------------------------------------- |
| `CONTEXT_SUMMARY_MODEL`           | `@cf/google/gemma-4-26b-a4b-it` | Model for conversation context summarization |
| `CONTEXT_SUMMARY_MAX_LENGTH`      | `4000`                          | Max summary length in characters             |
| `CONTEXT_SUMMARY_TIMEOUT_MS`      | `10000`                         | Summarization timeout                        |
| `CONTEXT_SUMMARY_MAX_MESSAGES`    | `50`                            | Max messages to include in summary           |
| `CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5`                             | Skip AI for conversations this short         |

## Idea Execution Timeouts

| Variable                                           | Default                                | Description                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK_RUN_MAX_EXECUTION_MS`                        | `14400000` (4 hr)                      | Max task execution time                                                                                                                                                                                                                                                |
| `TASK_STUCK_QUEUED_TIMEOUT_MS`                     | `1200000` (20 min)                     | Timeout for tasks stuck in queued state                                                                                                                                                                                                                                |
| `TASK_STUCK_DELEGATED_TIMEOUT_MS`                  | `1860000` (31 min)                     | Timeout for tasks stuck in delegated state                                                                                                                                                                                                                             |
| `TASK_DO_MISMATCH_GRACE_MS`                        | `300000` (5 min)                       | Minimum age before reconciling completed TaskRunner state with task-scoped liveness                                                                                                                                                                                    |
| `STUCK_TASK_MAX_CANDIDATES_PER_SWEEP`              | `100`                                  | Maximum active tasks inspected by each recovery sweep                                                                                                                                                                                                                  |
| `STUCK_TASK_SCAN_CURSOR_KV_KEY`                    | `scheduled:stuck-tasks:scan-cursor:v1` | KV key used to resume bounded recovery scans fairly across active tasks                                                                                                                                                                                                |
| `TASK_LIVENESS_MAX_ACP_SESSIONS`                   | `5`                                    | Maximum task-scoped ACP sessions inspected per liveness probe                                                                                                                                                                                                          |
| `TASK_LIVENESS_PROBE_TIMEOUT_MS`                   | `5000` (5 sec)                         | Per-candidate timeout for ACP and Instant lifecycle probes used by ProjectData heartbeat deferral, idle cleanup, and stuck-task reconciliation; a timeout is inconclusive and preserves the task and workspace                                                         |
| `TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS`       | `5000` (5 sec)                         | Per-candidate timeout for stale-VM-node health probes used by ProjectData idle cleanup and stuck-task reconciliation; a timeout is inconclusive and preserves the task and workspace                                                                                   |
| `IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP`            | `5`                                    | Maximum exact-session task candidates inspected by a ProjectData idle-cleanup pass; workspace deletion is deferred when this bound cannot prove every reporter-scoped runtime conclusively dead                                                                        |
| `IDLE_CLEANUP_MAX_RESIDENCE_MS`                    | `7200000` (2 hr)                       | Maximum residence for a ProjectData idle-cleanup schedule before repeated preserved/error outcomes stop re-arming, preserve the workspace, and surface an attention marker                                                                                             |
| `TASK_RUN_ABSOLUTE_CEILING_MS`                     | `86400000` (24 hr)                     | Absolute runaway-cost ceiling; fails even a task with a demonstrably live runtime                                                                                                                                                                                      |
| `CLAUDE_CODE_COMPACTION_LOOP_DETECTOR_ENABLED`     | `true`                                 | Enable Claude Code compaction-loop shutdown from recent message evidence                                                                                                                                                                                               |
| `CLAUDE_CODE_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT` | `40`                                   | Recent task-session messages to inspect for compaction-loop evidence                                                                                                                                                                                                   |
| `CLAUDE_CODE_COMPACTION_LOOP_WINDOW_MESSAGES`      | `20`                                   | Rolling recent-message window used for compaction-loop detection                                                                                                                                                                                                       |
| `CLAUDE_CODE_COMPACTION_LOOP_MIN_PAIRS`            | `3`                                    | Minimum `Compacting...` / `Compacting completed` marker pairs before failing a task                                                                                                                                                                                    |
| `TASK_CALLBACK_TIMEOUT_MS`                         | `10000`                                | Callback response timeout                                                                                                                                                                                                                                              |
| `TASK_CALLBACK_RETRY_MAX_ATTEMPTS`                 | `3`                                    | Max callback retry attempts                                                                                                                                                                                                                                            |
| `TASK_RUN_CLEANUP_DELAY_MS`                        | `5000`                                 | Delay before task cleanup                                                                                                                                                                                                                                              |
| `TASK_RECONCILIATION_IDLE_MS`                      | `300000` (5 min)                       | Idle threshold before SAM sends a visible task check-in                                                                                                                                                                                                                |
| `TASK_RECONCILIATION_RESPONSE_DEADLINE_MS`         | `60000` (1 min)                        | Response deadline after a visible task check-in                                                                                                                                                                                                                        |
| `TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS`         | `1800000` (30 min)                     | In-flight prompt observation threshold before a non-interrupting reconciliation event                                                                                                                                                                                  |
| `TASK_RECONCILIATION_PROMPT_HARD_STALL_MS`         | `7200000` (2 hr)                       | In-flight prompt hard-stall threshold before SAM requests prompt cancellation                                                                                                                                                                                          |
| `TASK_RECONCILIATION_MIN_ALARM_DELAY_MS`           | `10000` (10 sec)                       | Minimum delay before the next reconciliation alarm can fire                                                                                                                                                                                                            |
| `INSTANT_START_STALE_TIMEOUT_MS`                   | `600000` (10 min)                      | How long an Instant session may sit mid-launch (execution step `instant_persistence`) before the recovery sweep treats its start as stuck and fails it. Instant starts are accepted and then finished in the background, so this bounds a launch that never completes. |

### Durable prompt delivery and checkpoint storage

Durable prompt delivery is enabled by default so a follow-up can remain queued while a sleeping VM is replaced and restored. Legacy VM compatibility remains disabled: targets must advertise stable delivery receipts, and receipt ambiguity fails visibly rather than being guessed or replayed.

| Variable                                     | Default           | Description                                                                                                     |
| -------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `DURABLE_PROMPT_DELIVERY_ENABLED`            | `true`            | Persist prompts and deliver them from ProjectData alarms, including sleeping-session wake.                      |
| `PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED`   | `false`           | Explicit old-VM compatibility switch; receipt ambiguity still fails visibly and is never guessed or replayed.   |
| `PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM`   | `5`               | Maximum delivery claims started by one alarm pass.                                                              |
| `PROMPT_DELIVERY_MAX_ATTEMPTS`               | `5`               | Counted delivery attempts before retryable busy/not-ready waits use capped backoff; TTL remains the hard bound. |
| `PROMPT_DELIVERY_RETRY_BASE_MS`              | `5000`            | Initial retry delay.                                                                                            |
| `PROMPT_DELIVERY_RETRY_MAX_MS`               | `300000`          | Maximum exponential retry delay.                                                                                |
| `PROMPT_DELIVERY_TTL_MS`                     | `3600000`         | Maximum unresolved delivery lifetime.                                                                           |
| `PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS`         | `30000`           | Age at which an unconfirmed claim enters receipt reconciliation.                                                |
| `PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS`      | `5000`            | Timeout for background VM delivery and receipt calls.                                                           |
| `PROMPT_DELIVERY_MIN_ALARM_DELAY_MS`         | `1000`            | Minimum delay before the next delivery alarm.                                                                   |
| `ACP_LONG_TURN_SUPERVISOR_ENABLED`           | `false`           | Reserved long-turn candidate/preemption engine switch; this release leaves it inert.                            |
| `ACP_LONG_TURN_CHECKPOINT_MS`                | `18000000` (5 hr) | Reserved checkpoint eligibility threshold.                                                                      |
| `ACP_CHECKPOINT_PREEMPT_GRACE_MS`            | `30000`           | Reserved graceful preemption window.                                                                            |
| `ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS`    | `30000`           | D1 reconciliation backstop interval for active parent waits.                                                    |
| `ORCHESTRATOR_WAIT_MAX_CHILDREN`             | `20`              | Maximum same-project task IDs selected by one durable wait (hard ceiling: `90`, preserving D1 bind headroom).   |
| `ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT`   | `100`             | Maximum active durable parent waits per project.                                                                |
| `ORCHESTRATOR_WAIT_MAX_DURATION_MS`          | `86400000`        | Maximum finite wait deadline.                                                                                   |
| `ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM` | `10`              | Maximum wait subscriptions reconciled by one ProjectData alarm.                                                 |

ProjectData stores a single prompt-delivery queue and checkpoint episodes keyed by ACP session and prompt epoch. Sleeping-session prompts stay in that queue until strict restore succeeds, then use stable receipts for exactly-once acceptance. Task agents can register `wait_for_subtasks` for same-project tasks; terminal hooks provide low-latency nudges, bounded alarms reconcile missed writers, and one stable delivery ID wakes the caller exactly once. Automatic checkpoint preemption remains disabled.

> **Liveness-gated recovery.** Stuck-task recovery for `in_progress` tasks (including task-mode work paused at the `awaiting_followup` execution step) is gated on **task-scoped** liveness — a live workspace, a healthy node with a recent heartbeat, **and** an active task-scoped ACP session. A shared-node heartbeat alone is never sufficient. Consequently, `TASK_RUN_HARD_TIMEOUT_MS` and `TASK_RUN_MAX_EXECUTION_MS` bound the point at which a task with **no** proven live runtime is failed; a task with a demonstrably live runtime is preserved past those thresholds, but remains bounded by `TASK_RUN_ABSOLUTE_CEILING_MS` (24 hours by default) as a runaway-cost backstop. When liveness cannot be determined (probe timeout or error), the task is left untouched (fail-safe) until it reaches that absolute ceiling.

## Node & Workspace Readiness

| Variable                                 | Default              | Description                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_AGENT_READY_TIMEOUT_MS`            | `900000` (15 min)    | Wait for VM agent to report ready                                                                                                                                                                            |
| `NODE_AGENT_READY_POLL_INTERVAL_MS`      | `5000`               | Poll interval for agent readiness                                                                                                                                                                            |
| `VM_AGENT_REQUIRED_VERSION`              | _(deploy-generated)_ | Required vm-agent build for reusable VM nodes. Official deploys derive this from the Git commit SHA after publishing matching binaries; leave unset only for local/manual development or skip-agent deploys. |
| `TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` | `1800000` (30 min)   | Max wait for workspace-ready callback                                                                                                                                                                        |
| `PROVISIONING_TIMEOUT_MS`                | `1800000` (30 min)   | Cron marks stuck workspaces as error                                                                                                                                                                         |
| `NODE_HEARTBEAT_STALE_SECONDS`           | `180`                | Seconds without a heartbeat before a node is treated as stale                                                                                                                                                |

## App Deployment Routing

| Variable                                      | Default                                | Description                                                           |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `DEPLOY_PAYLOAD_EXPIRY_SECONDS`               | `3600`                                 | Signed deployment apply payload lifetime                              |
| `DEPLOYMENT_ROUTE_PORT_BASE`                  | `35000`                                | First node-local loopback port reserved for app routes                |
| `DEPLOYMENT_ROUTE_PORT_SPAN`                  | `100`                                  | Number of loopback ports reserved per deployment environment          |
| `AGENT_DEPLOYMENT_RESERVED_ENVIRONMENT_NAMES` | `prod,production`                      | Comma-separated environment names agents cannot create through MCP    |
| `MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE`        | `5`                                    | Maximum deployment environments to place on one deployment node       |
| `DEPLOYMENT_DEFAULT_VM_SIZE`                  | `small`                                | Default VM size for deployment nodes                                  |
| `DEPLOYMENT_MODEL_RUNNER_VM_SIZE`             | `medium`                               | VM size for deployment nodes that need Docker Model Runner            |
| `DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB`          | `256`                                  | Default per-service memory limit for compose-publish releases         |
| `DEPLOYMENT_LOG_MAX_SIZE`                     | `10m`                                  | Default json-file log max-size for compose-publish releases           |
| `DEPLOYMENT_LOG_MAX_FILE`                     | `3`                                    | Default json-file log max-file for compose-publish releases           |
| `MCP_DEPLOYMENT_COMPOSE_PREVIEW_MAX_BYTES`    | `128000`                               | Max Compose YAML size accepted by deployment route preview MCP tool   |
| `BUILD_PUBLISH_TOOL_TIMEOUT_MS`               | `1260000`                              | Worker-to-VM proxy timeout for `build_and_publish`                    |
| `DEPLOY_ACME_EMAIL`                           | _(unset)_                              | Optional ACME contact email emitted into deployment-node Caddy config |
| `DEPLOY_ACME_CA`                              | _(unset)_                              | Optional ACME CA directory override, useful for Let's Encrypt staging |
| `DOH_RESOLVER_URL`                            | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS resolver used to verify deployment custom domains      |
| `DOH_TIMEOUT_MS`                              | `10000`                                | Timeout for deployment custom-domain DNS verification lookups         |
| `DEPLOY_COMPOSE_CMD`                          | `docker compose`                       | Docker Compose command used by the deployment engine                  |
| `DEPLOY_HEALTH_TIMEOUT`                       | `5m`                                   | Deployment health-check timeout used by the VM agent                  |
| `DEPLOY_RUNTIME_TIMEOUT`                      | `15m`                                  | VM-agent max time for deployment-node host dependency setup           |
| `GRACEFUL_SHUTDOWN_TIMEOUT`                   | `30s`                                  | VM-agent max time for graceful HTTP server shutdown after SIGTERM     |
| `SYSTEM_PROVISIONING_TIMEOUT`                 | `15m`                                  | VM-agent max time for workspace host provisioning before bootstrap    |
| `CF_IP_FETCH_TIMEOUT`                         | `10s`                                  | VM-agent timeout for Cloudflare IP range fetches during provisioning  |
| `BOOT_LOG_HTTP_TIMEOUT`                       | `10s`                                  | VM-agent timeout for boot-log callbacks to the control plane          |
| `MCP_SHORT_COMMAND_TIMEOUT`                   | `10s`                                  | VM-agent timeout for short MCP workspace command probes               |
| `MCP_DIFF_COMMAND_TIMEOUT`                    | `30s`                                  | VM-agent timeout for MCP diff-summary git commands                    |
| `MCP_BUILD_PREPARE_TIMEOUT`                   | `30s`                                  | VM-agent timeout for MCP build/publish preparation probes             |
| `JWKS_FETCH_TIMEOUT`                          | `10s`                                  | VM-agent startup JWKS fetch timeout                                   |
| `ACP_CREDENTIAL_SYNC_TIMEOUT`                 | `10s`                                  | VM-agent ACP auth-file sync-back timeout during shutdown              |
| `ACP_ACTIVITY_REPORT_TIMEOUT`                 | `10s`                                  | VM-agent timeout for each ACP activity callback attempt               |
| `DEVCONTAINER_CACHE_PUSH_TIMEOUT`             | `10m`                                  | VM-agent best-effort devcontainer cache image push timeout            |
| `DEPLOY_PREFLIGHT_COMMAND_TIMEOUT`            | `15s`                                  | VM-agent deployment preflight diagnostic command timeout              |
| `LOG_STREAM_PING_WRITE_TIMEOUT`               | `10s`                                  | VM-agent log-stream WebSocket ping write deadline                     |
| `DEPLOY_TEARDOWN_TIMEOUT`                     | `2m`                                   | VM-agent max time for deployment environment teardown (stop/start)    |
| `DEPLOY_APPLY_IDLE_TIMEOUT`                   | `15m`                                  | VM-agent idle watchdog for deployment apply (no-progress only)        |
| `DEPLOY_BUILD_PUBLISH_TIMEOUT`                | `20m`                                  | VM-agent max time for host build + push + release publish             |
| `DEPLOY_ARTIFACT_DIAL_TIMEOUT`                | `30s`                                  | VM-agent TCP dial timeout for artifact downloads                      |
| `DEPLOY_ARTIFACT_TLS_HANDSHAKE_TIMEOUT`       | `15s`                                  | VM-agent TLS handshake timeout for artifact downloads                 |
| `DEPLOY_ARTIFACT_RESPONSE_HEADER_TIMEOUT`     | `60s`                                  | VM-agent first-response-header timeout for artifact downloads         |
| `DEPLOY_ARTIFACT_IDLE_TIMEOUT`                | `2m`                                   | VM-agent idle watchdog for artifact body-read progress                |

## Platform Limits

| Variable                                     | Default            | Description                                                                   |
| -------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `MAX_NODES_PER_USER`                         | `10`               | Max nodes per user                                                            |
| `MAX_WORKSPACES_PER_NODE`                    | `3`                | Max workspaces packed onto one node                                           |
| `VM_ADMISSION_CONTROL_MODE`                  | `enforce`          | VM task/session admission mode: `off`, `shadow`, or `enforce`                 |
| `VM_ADMISSION_LEASE_TTL_MS`                  | `1200000` (20 min) | Fenced provisioning-claim lease duration                                      |
| `VM_ADMISSION_RETRY_MIN_MS`                  | `15000`            | Minimum retry delay for tasks waiting on VM capacity                          |
| `VM_ADMISSION_RETRY_MAX_MS`                  | `60000`            | Maximum retry delay for tasks waiting on VM capacity                          |
| `VM_ADMISSION_WAIT_TIMEOUT_MS`               | `7200000` (2 h)    | Maximum visible wait for VM capacity before failing the task                  |
| `VM_ADMISSION_PROVIDER_COOLDOWN_MS`          | `600000` (10 min)  | Cooldown after provider/account capacity errors such as Hetzner server limits |
| `VM_ADMISSION_WAKE_BATCH_SIZE`               | `25`               | Maximum waiting TaskRunner DOs nudged by one capacity event                   |
| `VM_ADMISSION_DIAGNOSTIC_MESSAGE_MAX_LENGTH` | `500`              | Maximum provider diagnostic message length stored on admission records        |
| `MAX_AGENT_SESSIONS_PER_WORKSPACE`           | `10`               | Max concurrent agent sessions                                                 |
| `MAX_PROJECTS_PER_USER`                      | `100`              | Max projects per user                                                         |
| `MAX_TASKS_PER_PROJECT`                      | `10000`            | Max ideas per project                                                         |
| `MAX_TASK_MESSAGE_LENGTH`                    | `16000`            | Max idea description length                                                   |

## Durable Object Limits

| Variable                                                   | Default                      | Description                                                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_SESSIONS_PER_PROJECT`                                 | `10000`                      | Max chat sessions per project                                                                                                                                                    |
| `MAX_MESSAGES_PER_SESSION`                                 | `100000`                     | Max messages per chat session                                                                                                                                                    |
| `COMMENT_BODY_MAX_LENGTH`                                  | `8000`                       | Max characters per message-anchored comment or reply body                                                                                                                        |
| `COMMENT_QUOTE_MAX_LENGTH`                                 | `2000`                       | Max characters preserved from quoted message text                                                                                                                                |
| `COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH`                       | `200`                        | Max `clientMutationId` length for message-anchored comment writes                                                                                                                |
| `COMMENT_LIST_LIMIT_DEFAULT`                               | `100`                        | Default page size for comment thread lists                                                                                                                                       |
| `COMMENT_LIST_LIMIT_MAX`                                   | `500`                        | Max page size for comment thread lists                                                                                                                                           |
| `COMMENT_THREADS_PER_SESSION_MAX`                          | `1000`                       | Max message-anchored comment threads per chat session                                                                                                                            |
| `COMMENT_REPLIES_PER_THREAD_MAX`                           | `200`                        | Max replies per message-anchored comment thread                                                                                                                                  |
| `PROJECT_COMMENT_LIST_LIMIT`                               | `100`                        | Page size for the project-wide comment inbox                                                                                                                                     |
| `PROJECT_COMMENT_LIST_MAX`                                 | `300`                        | Max page size for the project-wide comment inbox                                                                                                                                 |
| `PROJECT_COMMENT_LIST_MAX_BYTES`                           | `4000000`                    | Byte budget for one project-wide comment inbox response, so a few very long threads cannot exhaust the Durable Object RPC limit                                                  |
| `DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES`                       | `16384`                      | Max compact metadata bytes preserved for library document cards                                                                                                                  |
| `PROJECT_DATA_TOOL_METADATA_MAX_BYTES`                     | `131072`                     | Max stored `tool_metadata` bytes per message before oversized tool content is stripped into bounded metadata                                                                     |
| `PROJECT_DATA_STORAGE_TELEMETRY_ENABLED`                   | `true`                       | Enables ProjectData `databaseSize` alarm measurement and D1 telemetry writes                                                                                                     |
| `PROJECT_DATA_STORAGE_LIMIT_BYTES`                         | `10000000000`                | Cloudflare SQLite-backed Durable Object storage limit used for ProjectData usage classification                                                                                  |
| `PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS`                 | `3600000`                    | Minimum interval between per-object ProjectData storage measurements                                                                                                             |
| `PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS`                   | `21600000`                   | Minimum interval between repeated warning/critical/degraded ProjectData storage observability alerts and cleanup target-unreachable alerts                                       |
| `PROJECT_DATA_STORAGE_NOTICE_RATIO`                        | `0.6`                        | ProjectData storage usage ratio classified as `notice`                                                                                                                           |
| `PROJECT_DATA_STORAGE_WARNING_RATIO`                       | `0.8`                        | ProjectData storage usage ratio classified as `warning`                                                                                                                          |
| `PROJECT_DATA_STORAGE_CRITICAL_RATIO`                      | `0.9`                        | ProjectData storage usage ratio classified as `critical`                                                                                                                         |
| `PROJECT_DATA_STORAGE_DEGRADED_RATIO`                      | `0.95`                       | ProjectData storage usage ratio classified as `degraded`                                                                                                                         |
| `PROJECT_DATA_STORAGE_EMERGENCY_TARGET_RATIO`              | `0.9`                        | Target usage ratio for explicit superadmin ProjectData emergency purge calls                                                                                                     |
| `PROJECT_DATA_STORAGE_EMERGENCY_BATCH_ROWS`                | `500`                        | Oldest `activity_events` and `acp_session_events` rows deleted per table per emergency purge batch                                                                               |
| `PROJECT_DATA_STORAGE_EMERGENCY_MAX_BATCHES`               | `4`                          | Maximum emergency purge batches per explicit call                                                                                                                                |
| `PROJECT_DATA_STORAGE_GROWTH_LOOKBACK_DAYS`                | `7`                          | Lookback window used to estimate ProjectData bytes/day growth and days to storage limit                                                                                          |
| `PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_DEFAULT`        | `50`                         | Default row count for admin ProjectData storage telemetry and history lists                                                                                                      |
| `PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_MAX`            | `200`                        | Max accepted row count for admin ProjectData storage telemetry and history lists                                                                                                 |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED`                | `true`                       | Enables automatic ProjectData cleanup that archives expandable `tool_metadata.content` payloads to private R2 before stripping them from old message rows                        |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO`          | `0.8`                        | ProjectData storage usage ratio that starts automatic tool payload archival cleanup even before the retention cadence is due                                                     |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO`           | `0.75`                       | ProjectData storage usage ratio below which automatic tool payload cleanup stops                                                                                                 |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS`             | `500`                        | Maximum tool-message rows inspected by one automatic cleanup alarm batch                                                                                                         |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES`            | `1048576`                    | Maximum legacy `tool_metadata` bytes read into JS by one automatic archival cleanup alarm batch                                                                                  |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES`          | `1048576`                    | Maximum single legacy `tool_metadata` row bytes read into JS by archival cleanup; larger rows fail closed unless the operator deliberately raises this limit                     |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS`   | `7`                          | Legacy terminal-session age guard retained for storage telemetry compatibility; tool payload archival uses `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS`                    |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS`             | `60000`                      | Delay before the next automatic cleanup alarm batch when more candidates remain                                                                                                  |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM` | `25`                         | Legacy terminal-session cleanup knob retained for env compatibility; archival cleanup scans tool-message rows directly                                                           |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS`           | `20000`                      | Soft wall-clock budget for one ProjectData tool payload archival cleanup alarm pass                                                                                              |
| `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS`         | `7`                          | Message age before expandable tool payload JSON may be archived to private R2 and stripped from the ProjectData DO                                                               |
| `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS`            | `86400000`                   | Cadence for the retention-driven ProjectData tool payload archival scan                                                                                                          |
| `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX`              | `project-data/tool-payloads` | Private R2 prefix used for archived ProjectData tool payload JSON objects                                                                                                        |
| `PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED`                   | `true`                       | Enables automatic deletion of old low-value terminal-session `activity_events` and terminal ACP event history when storage remains above the cleanup target                      |
| `PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS`                | `500`                        | Maximum terminal `activity_events` rows and terminal `acp_session_events` rows deleted per automatic cleanup alarm batch                                                         |
| `PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS`      | `7`                          | Minimum terminal-session age before automatic event-log cleanup may delete its activity/ACP event history                                                                        |
| `PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS`                | `60000`                      | Delay before the next terminal event-log cleanup alarm batch when more candidates remain                                                                                         |
| `MESSAGE_SIZE_THRESHOLD`                                   | `102400`                     | Max message size in bytes                                                                                                                                                        |
| `ACTIVITY_RETENTION_DAYS`                                  | `90`                         | Days to retain activity events                                                                                                                                                   |
| `SESSION_IDLE_TIMEOUT_MINUTES`                             | `60`                         | Idle session timeout                                                                                                                                                             |
| `SESSION_ACTIVITY_STALE_THRESHOLD_MS`                      | `300000` (5 min)             | Evidence threshold before stale working activity can be healed to idle                                                                                                           |
| `SESSION_ACTIVITY_PROBE_TIMEOUT_MS`                        | `5000` (5 s)                 | Timeout for the vm-agent session-activity probe. Background control-loop budget — deliberately far below the interactive node-agent timeout                                      |
| `SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS`                      | `3`                          | Consecutive unreachable probes after which a stale working state is terminalized as dead                                                                                         |
| `SESSION_ACTIVITY_PROBE_MAX_CANDIDATES`                    | `10`                         | Stale-activity candidates probed per ProjectData alarm pass                                                                                                                      |
| `DO_SUMMARY_SYNC_DEBOUNCE_MS`                              | `5000`                       | Debounce for DO-to-D1 summary sync                                                                                                                                               |
| `SESSION_INDEX_MAX_ROWS`                                   | `1000`                       | Sessions mirrored into the D1 `session_summaries` index per project. A project holding more is recorded as incomplete and its chat sidebar reads fall back to the Durable Object |
| `SESSION_INDEX_MAX_STALENESS_MS`                           | `900000` (15 min)            | How stale the session index may be before the per-project sidebar list stops trusting it and falls back to the Durable Object                                                    |

Ordinary ProjectData storage alarms record O(1) `databaseSize` telemetry and
bounded cleanup row/byte counters. Category breakdown scans are reserved for
explicit/admin measurement paths so hot ProjectData alarms do not delay
lifecycle bookkeeping.

## Durable Object Retry

| Variable                               | Default | Description                                                                                                                                                                                |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DO_RETRY_MAX_ATTEMPTS`                | `8`     | Max attempts for transient Durable Object RPC reset/overload errors                                                                                                                        |
| `DO_RETRY_BASE_DELAY_MS`               | `100`   | Base retry delay in milliseconds for transient Durable Object RPC failures                                                                                                                 |
| `DO_RETRY_MAX_DELAY_MS`                | `250`   | Max per-attempt retry delay for transient Durable Object RPC failures                                                                                                                      |
| `PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES` | `2000`  | Max ProjectData Durable Objects one Worker isolate remembers as already having a persisted `projectId`, so `ensureProjectId` costs one RPC per isolate instead of one before every DO call |

## Runtime Config Limits

| Variable                                   | Default  | Description                                |
| ------------------------------------------ | -------- | ------------------------------------------ |
| `MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT` | `150`    | Max env vars per project                   |
| `MAX_PROJECT_RUNTIME_FILES_PER_PROJECT`    | `50`     | Max files per project                      |
| `MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES`      | `8192`   | Max bytes per env var value                |
| `MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES`   | `131072` | Max bytes per file content                 |
| `MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH`     | `256`    | Max file path length                       |
| `MAX_DEPLOYMENT_ENV_VARS_PER_ENVIRONMENT`  | `100`    | Max deployment config vars per environment |
| `MAX_DEPLOYMENT_ENV_VALUE_BYTES`           | `65536`  | Max bytes per deployment config value      |
| `MAX_DEPLOYMENT_ENV_TOTAL_BYTES`           | `262144` | Max aggregate deployment config env size   |
| `MAX_MCP_CONNECTIONS_PER_SCOPE`            | `25`     | Max bring-your-own MCP servers per scope   |
| `MCP_CONNECTION_URL_MAX_BYTES`             | `2048`   | Max MCP endpoint URL size                  |
| `MCP_CONNECTION_TOKEN_MAX_BYTES`           | `8192`   | Max MCP bearer token size                  |

## External API Timeouts

| Variable                                   | Default            | Description                                                           |
| ------------------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `HETZNER_API_TIMEOUT_MS`                   | `30000`            | Hetzner API request timeout                                           |
| `CF_API_TIMEOUT_MS`                        | `30000`            | Cloudflare API request timeout                                        |
| `GCP_API_TIMEOUT_MS`                       | `30000`            | GCP OAuth, IAM, and Compute request timeout                           |
| `NODE_AGENT_REQUEST_TIMEOUT_MS`            | `30000`            | VM Agent request timeout                                              |
| `DIGITALOCEAN_API_TIMEOUT_MS`              | `30000`            | DigitalOcean API request timeout                                      |
| `DIGITALOCEAN_IP_POLL_TIMEOUT_MS`          | `20000`            | Bounded best-effort public IPv4 poll budget                           |
| `DIGITALOCEAN_IP_POLL_INTERVAL_MS`         | `3000`             | Public IPv4 poll interval                                             |
| `DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS`      | `60000`            | Block Storage action completion budget                                |
| `DIGITALOCEAN_ACTION_POLL_INTERVAL_MS`     | `1000`             | Block Storage action poll interval                                    |
| `DIGITALOCEAN_MAX_LIST_PAGES`              | `20`               | Maximum pages per DigitalOcean list request                           |
| `DIGITALOCEAN_REGION`                      | `fra1`             | Default DigitalOcean region                                           |
| `DIGITALOCEAN_IMAGE`                       | `ubuntu-24-04-x64` | Default Droplet image slug                                            |
| `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` | `120000`           | Instant-session create-workspace budget (includes in-container clone) |

## Admin Observability

| Variable                                    | Default  | Description                         |
| ------------------------------------------- | -------- | ----------------------------------- |
| `OBSERVABILITY_ERROR_RETENTION_DAYS`        | `30`     | Error log retention                 |
| `OBSERVABILITY_ERROR_MAX_ROWS`              | `100000` | Max stored error rows               |
| `OBSERVABILITY_ERROR_BATCH_SIZE`            | `25`     | Error ingestion batch size          |
| `OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH`    | `2048`   | Maximum persisted message length    |
| `OBSERVABILITY_ERROR_STACK_MAX_LENGTH`      | `4096`   | Maximum persisted stack length      |
| `OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH` | `512`    | Maximum persisted user-agent length |
| `OBSERVABILITY_LOG_QUERY_RATE_LIMIT`        | `30`     | Log queries per minute per admin    |

## VM TLS

| Variable                       | Default | Description                                                           |
| ------------------------------ | ------- | --------------------------------------------------------------------- |
| `VM_AGENT_PROTOCOL`            | `https` | Protocol for VM agent communication                                   |
| `VM_AGENT_PORT`                | `8443`  | VM agent listening port                                               |
| `ORIGIN_CA_CERT_VALIDITY_DAYS` | `7`     | Validity for per-node Origin CA certificates signed by the API Worker |

New nodes generate `/etc/sam/tls/origin-ca-key.pem` locally in cloud-init and fetch only the signed certificate from `POST /api/nodes/:id/origin-ca-certificate` (`packages/cloud-init/src/template.ts`, `apps/api/src/routes/node-lifecycle.ts`). Legacy `ORIGIN_CA_CERT` and `ORIGIN_CA_KEY` Worker secrets are not required for new node provisioning.

## Journald Configuration (VM)

Applied via cloud-init on each node:

| Setting           | Default      | Description                   |
| ----------------- | ------------ | ----------------------------- |
| `SystemMaxUse`    | `500M`       | Max disk space for journal    |
| `SystemKeepFree`  | `1G`         | Minimum free disk to maintain |
| `MaxRetentionSec` | `7day`       | Max log retention period      |
| `Storage`         | `persistent` | Persist logs across reboots   |
| `Compress`        | `yes`        | Compress stored entries       |

## File Upload & Download

| Variable                      | Default              | Description                     |
| ----------------------------- | -------------------- | ------------------------------- |
| `FILE_UPLOAD_MAX_BYTES`       | `52428800` (50 MB)   | Max size per uploaded file      |
| `FILE_UPLOAD_BATCH_MAX_BYTES` | `262144000` (250 MB) | Max total size per upload batch |
| `FILE_UPLOAD_TIMEOUT`         | `120s`               | Upload timeout (VM agent)       |
| `FILE_UPLOAD_TIMEOUT_MS`      | `120000` (120s)      | Upload proxy timeout (Worker)   |
| `FILE_DOWNLOAD_TIMEOUT_MS`    | `60000` (60s)        | Download proxy timeout          |
| `FILE_DOWNLOAD_MAX_BYTES`     | `52428800` (50 MB)   | Max download file size          |

## File Browsing & Raw Proxy

| Variable                        | Default            | Description                           |
| ------------------------------- | ------------------ | ------------------------------------- |
| `FILE_PROXY_TIMEOUT_MS`         | `15000`            | File proxy request timeout            |
| `FILE_PROXY_MAX_RESPONSE_BYTES` | `2097152` (2 MB)   | Max file proxy response size          |
| `FILE_RAW_MAX_SIZE`             | `52428800` (50 MB) | Max raw binary file size (VM agent)   |
| `FILE_RAW_TIMEOUT`              | `60s`              | Raw file streaming timeout (VM agent) |
| `FILE_RAW_PROXY_MAX_BYTES`      | `52428800` (50 MB) | Max raw file proxy size (Worker)      |

## Project Files (Remote-Branch Git Browser)

| Variable                        | Default          | Description                                                       |
| ------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `REPO_BROWSE_MAX_INLINE_BYTES`  | `1000000` (1 MB) | Max bytes to inline as text in the file viewer; larger stream raw |
| `REPO_BROWSE_MAX_COMPARE_FILES` | `300`            | Max changed files in an Artifacts diff before truncation          |

## MCP Tool Limits

| Variable                               | Default | Description                                             |
| -------------------------------------- | ------- | ------------------------------------------------------- |
| `MCP_IDEA_CONTEXT_MAX_LENGTH`          | `500`   | Max characters of idea context shown to agents          |
| `MCP_IDEA_LIST_LIMIT`                  | `20`    | Default page size for `list_ideas`                      |
| `MCP_IDEA_LIST_MAX`                    | `100`   | Max page size for `list_ideas`                          |
| `MCP_IDEA_SEARCH_MAX`                  | `20`    | Max results from `search_ideas`                         |
| `MCP_MESSAGE_SEARCH_MAX`               | `20`    | Max results from `search_messages`                      |
| `MCP_MESSAGE_LIST_LIMIT`               | `50`    | Default page size for `get_session_messages`            |
| `MCP_MESSAGE_LIST_MAX`                 | `200`   | Max messages per `get_session_messages` request         |
| `MCP_ARCHIVED_TOOL_PAYLOAD_LIST_LIMIT` | `10`    | Default page size for `get_archived_tool_payloads`      |
| `MCP_ARCHIVED_TOOL_PAYLOAD_LIST_MAX`   | `50`    | Max archived payloads per `get_archived_tool_payloads`  |
| `MCP_COMMENT_LIST_LIMIT`               | `10`    | Default page size for `list_message_comment_threads`    |
| `MCP_COMMENT_LIST_MAX`                 | `25`    | Max threads per `list_message_comment_threads` request  |
| `MCP_COMMENT_BODY_MAX_LENGTH`          | `4000`  | Max comment/reply body characters accepted through MCP  |
| `MCP_COMMENT_QUOTE_MAX_LENGTH`         | `1000`  | Max quoted source-message characters returned to agents |
| `COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH` | `6000`  | Max send-to-agent comment directive prompt length       |
| `MCP_TRIGGER_LIST_LIMIT`               | `20`    | Default page size for `list_triggers`                   |
| `MCP_TRIGGER_LIST_MAX`                 | `100`   | Max triggers per `list_triggers` request                |
| `MCP_INCIDENT_LIST_LIMIT`              | `10`    | Default page size for private `list_incident_queue`     |
| `MCP_INCIDENT_LIST_MAX`                | `50`    | Max private incidents per `list_incident_queue` request |

## Web UI (Build-Time)

| Variable                                    | Default            | Description                                                              |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `VITE_FILE_PREVIEW_INLINE_MAX_BYTES`        | `10485760` (10 MB) | Images below this size render inline automatically                       |
| `VITE_FILE_PREVIEW_LOAD_MAX_BYTES`          | `52428800` (50 MB) | Images below this size show click-to-load; above shows download link     |
| `VITE_ANALYTICS_MAX_QUEUE_SIZE`             | `100`              | Max client-side analytics events retained before oldest events drop      |
| `VITE_ANALYTICS_FLUSH_THRESHOLD`            | `10`               | Client event count that triggers an immediate analytics flush            |
| `VITE_ANALYTICS_FLUSH_INTERVAL_MS`          | `5000`             | Client analytics background flush interval in milliseconds               |
| `VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES`      | `100`              | Max paginated diagnosis-event pages loaded per browser request           |
| `VITE_PROJECT_LIST_LIMIT`                   | `50`               | Projects loaded into each shared list-cache entry                        |
| `VITE_PROJECT_POLL_INTERVAL_MS`             | `30000`            | Project-list page refresh cadence in milliseconds; `0` disables          |
| `VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS`     | `60000`            | App-shell project-list refresh cadence in milliseconds; `0` disables     |
| `VITE_WORKSPACE_PORTS_POLL_MS`              | `10000`            | Workspace forwarded-port base refresh cadence in milliseconds            |
| `VITE_WORKSPACE_PORTS_BACKOFF_MAX_MS`       | `120000`           | Maximum backoff between forwarded-port readiness polls                   |
| `VITE_WORKSPACE_PORTS_FAILURE_BUDGET`       | `6`                | Consecutive unavailable port-list responses before circuit cooldown      |
| `VITE_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO` | `0.2`              | +/- jitter ratio applied to forwarded-port readiness backoff delays      |
| `VITE_WORKSPACE_PORTS_CIRCUIT_RESET_MS`     | `300000`           | Open-circuit cooldown before probing forwarded-port readiness again      |
| `VITE_PROJECT_PREFETCH_DELAY_MS`            | `120`              | Mouse dwell before project-detail prefetch; focus/touch are immediate    |
| `VITE_BACKGROUND_FETCH_DELAY_MS`            | `150`              | Delay before background query activity is shown and announced            |
| `VITE_CHUNK_LOAD_RETRY_DELAY_MS`            | `350`              | Wait before retrying a failed lazy route-chunk import                    |
| `VITE_CHUNK_RELOAD_COOLDOWN_MS`             | `15000`            | Minimum gap between chunk-recovery reloads; guards against a reload loop |
| `VITE_ROUTE_FALLBACK_REVEAL_DELAY_MS`       | `180`              | Delay before the route loading spinner fades in, avoiding a flash        |
| `VITE_QUERY_PERSIST_MAX_AGE_MS`             | `86400000` (24 h)  | How long a persisted query-cache record may be restored after writing    |
| `VITE_QUERY_PERSIST_THROTTLE_MS`            | `1000`             | Minimum gap between IndexedDB writes of the query cache                  |
| `VITE_QUERY_PERSIST_RESTORE_TIMEOUT_MS`     | `250`              | Budget for the initial cache restore before failing open to no cache     |
| `VITE_AGENT_CATALOG_STALE_TIME_MS`          | `300000`           | Freshness window for the installable agent catalog query                 |
| `VITE_PROVIDER_CATALOG_STALE_TIME_MS`       | `300000`           | Freshness window for provider catalog size/location/price metadata       |
| `VITE_TRIAL_STATUS_STALE_TIME_MS`           | `60000`            | Freshness window for trial availability status                           |
| `VITE_CACHED_COMMANDS_STALE_TIME_MS`        | `300000`           | Freshness window for cached slash-command registries                     |
| `VITE_PROJECT_CREATE_CONFIG_STALE_TIME_MS`  | `300000`           | Freshness window for project-creation config flags                       |

### Query cache persistence

The control-plane UI writes an allowlisted slice of its query cache to IndexedDB so a full page
reload paints from cache instead of refetching. Persisted slices are limited to allowlisted
project summaries, stripped library indexes, and project-chat session messages. Credentials,
admin diagnostics, node and workspace runtime details, file contents, signed URLs, and mutation state
are never written to disk.

Records are namespaced by authenticated user and by a schema version, and are deleted on sign-out
and on account switch, so one account can never be shown another account's cached data. If
IndexedDB is unavailable — private browsing, a storage quota failure, or a disabled store — the app
degrades silently to its normal in-memory cache.

## Analytics

SAM uses first-party analytics ingestion for operational/product aggregates. Browser events are batched to `/api/t`; request analytics are written by API middleware when enabled. Analytics is best-effort and disabled paths preserve normal application behavior.

Client page/referrer fields follow a privacy normalization contract before enqueue: query strings, fragments, protocol, host/userinfo for page values, credentials, emails, UUIDs/ULIDs, long opaque tokens, common secret prefixes, repository/code file identifiers, and values after sensitive route markers are removed or replaced with `[redacted]`. Non-sensitive nested path shape, event names, durations, UTM source/medium/campaign, session ID, visitor/authenticated user ID, and explicit safe entity metadata are preserved for aggregate reporting.

| Variable                                    | Default                                         | Description                                                                        |
| ------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ANALYTICS_ENABLED`                         | `true`                                          | Enable API middleware analytics; set `false` to skip request event writes          |
| `ANALYTICS_SKIP_ROUTES`                     | _(built-in skip list)_                          | Comma-separated extra route prefixes/patterns excluded from middleware writes      |
| `ANALYTICS_DATASET`                         | _(deployment-generated)_                        | Cloudflare Analytics Engine dataset name                                           |
| `ANALYTICS_SQL_API_URL`                     | `https://api.cloudflare.com/client/v4/accounts` | Analytics Engine SQL API base URL override                                         |
| `ANALYTICS_DEFAULT_PERIOD_DAYS`             | `30`                                            | Default admin analytics query lookback in days                                     |
| `ANALYTICS_TOP_EVENTS_LIMIT`                | `50`                                            | Max rows returned by top-events admin query                                        |
| `ANALYTICS_GEO_LIMIT`                       | `50`                                            | Max countries in geographic distribution view                                      |
| `ANALYTICS_RETENTION_WEEKS`                 | `12`                                            | Number of weeks for retention cohort analysis                                      |
| `ANALYTICS_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT` | `20`                                            | Max top pages/referrers/events in website traffic sections                         |
| `ANALYTICS_INGEST_ENABLED`                  | `true`                                          | Enable browser event ingestion at `/api/t`; `false` returns success without writes |
| `RATE_LIMIT_ANALYTICS_INGEST`               | `500`                                           | Analytics ingest requests allowed per IP per hour                                  |
| `MAX_ANALYTICS_INGEST_BATCH_SIZE`           | `25`                                            | Max browser events accepted per ingest request                                     |
| `MAX_ANALYTICS_INGEST_BODY_BYTES`           | `65536`                                         | Max ingest request body size in bytes                                              |
| `MAX_ANALYTICS_DURATION_MS`                 | `3600000`                                       | Max accepted page-duration value; larger values are clamped                        |

## Analytics Forwarding

External analytics forwarding is off by default. When enabled, SAM forwards only analytics rows already accepted by first-party ingestion/middleware; it does not bypass the client-side URL normalization contract.

| Variable                           | Default                                       | Description                                |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------ |
| `ANALYTICS_FORWARD_ENABLED`        | `false`                                       | Enable external analytics event forwarding |
| `ANALYTICS_FORWARD_EVENTS`         | key conversion events                         | Comma-separated list of events to forward  |
| `ANALYTICS_FORWARD_LOOKBACK_HOURS` | `25`                                          | Hours to look back for events              |
| `ANALYTICS_FORWARD_CURSOR_KEY`     | `analytics-forward-cursor`                    | KV key used to remember forwarded progress |
| `ANALYTICS_FORWARD_SQL_LIMIT`      | `10000`                                       | Max rows fetched per forwarding run        |
| `ANALYTICS_SQL_FETCH_TIMEOUT_MS`   | `30000`                                       | Timeout for Analytics Engine SQL fetches   |
| `SEGMENT_WRITE_KEY`                | _(unset)_                                     | Segment Write Key for event forwarding     |
| `SEGMENT_API_URL`                  | `https://api.segment.io/v1/batch`             | Segment API endpoint                       |
| `SEGMENT_MAX_BATCH_SIZE`           | `100`                                         | Max events per Segment batch request       |
| `GA4_MEASUREMENT_ID`               | _(unset)_                                     | Google Analytics 4 Measurement ID          |
| `GA4_API_SECRET`                   | _(unset)_                                     | Google Analytics 4 API secret              |
| `GA4_API_URL`                      | `https://www.google-analytics.com/mp/collect` | GA4 Measurement Protocol endpoint          |
| `GA4_MAX_BATCH_SIZE`               | `25`                                          | Max events per GA4 batch request           |
