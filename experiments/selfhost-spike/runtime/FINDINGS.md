# Self-host spike, Track A: SAM API Worker on celld v0.6.2

Research spike for Raphaël, task `01M72Q3V7PGDB31KZ371ANYB55`, 2026-11-10. Background and prior research
are in idea `01M72M9AEB933ZY8269D376DKC`. Branch: `sam/self-host-spike-track-anyb55`. This is not
shippable code.

## Verdict: GO WITH CONDITIONS

The unmodified `apps/api` Worker bundles, boots and serves SAM's core control-plane path on celld
v0.6.2. That covers sign-in, projects, chat sessions, messages, the project WebSocket, durable
delivery, crons, the Mastra SAM agent, and every DO, D1, KV, R2 and WebCrypto feature SAM relies on.
Nothing here forces a rewrite of the Worker.

The blockers sit at three boundaries:
1. Proxying node WebSockets through the Worker (a celld bug).
2. Cloudflare-only services that SAM hardcodes: AI Gateway and Workers AI, Analytics Engine,
   Artifacts, and container sessions.
3. Deploy-time configuration shape.

Each has a known, bounded fix. Conditions to proceed:

1. **WebSocket proxy (blocker for the main product path).** Terminal, agent chat to the VM, logs
   and port-preview WebSockets need either a celld fix or a Worker-side `WebSocketPair` bridge
   (Track B has a working bridge). Until then a self-hosted SAM can manage projects and chats but
   cannot attach to a running workspace through the Worker.
2. **Make Cloudflare-only services optional:**
   - an OpenAI-compatible base URL for control-plane LLM calls;
   - turn off Workers AI features: transcribe has no flag, and TTS defaults on;
   - no AI Gateway and Analytics Engine calls when `CF_ACCOUNT_ID` is unset;
   - gate guided credential setup on `SANDBOX_ENABLED`, not on the binding existing;
   - keep `CF_CONTAINER_ENABLED=false` (Instant sessions are a separate, bigger problem; see Track C).
3. **A real config generator:** the translation in `gen-wrangler-json.mjs`, plus separate R2
   buckets and flat D1 migration directories.
4. **Ops prerequisites from Track C:** TLS proxy with `CELLD_TRUST_FORWARDED_HEADERS=1`, a qualified
   bucket, `CELLD_LTX_RETENTION_SECS`, and secrets in plain vars.

No-go would only apply if the WebSocket proxy cannot be fixed or bridged. Track B already showed a
bridge working in `celld dev`.

## What I ran

- celld 0.6.2 (sha256 `ce0ee355…646c`, release binary) with esbuild 0.27.7 from the repo.
- First boot: `celld dev`.
- Everything else: a **real node** (`celld --bucket s3://celld-fleet`) on a local MinIO
  (`pgsty/minio`, the fork Track C qualified). `celld d1 …` cannot reach `celld dev`'s store.
- Throwaway keys from `gen-throwaway-secrets.mjs`. No Cloudflare credentials at any point.
- The hourly cron sent one request with dummy `CF_*` values before I removed them; see F14.
- Box: 4 vCPU, 8 GB, x86_64.

Reproduce with the files in this directory (paths relative to the repo root):

```bash
# celld 0.6.2 + esbuild on PATH; MinIO on 127.0.0.1:9100 with bucket celld-fleet (see node-env.sh)
mkdir -p .tmp/celld/project && cd .tmp/celld/project && ln -sfn ../../../apps/api/src src
node ../../../experiments/selfhost-spike/runtime/gen-throwaway-secrets.mjs > ../secrets.json
node ../../../experiments/selfhost-spike/runtime/gen-wrangler-json.mjs --out . --main src/index.ts \
  --secrets ../secrets.json --probe [--var SPIKE_OPENAI_COMPAT_BASE_URL=http://127.0.0.1:9200/v1]
. ../../../experiments/selfhost-spike/runtime/node-env.sh
CELLD_WATCH=$PWD/../node1 CELLD_ADDR=127.0.0.1:8791 CELLD_INTERNAL_ADDR=127.0.0.1:7101 celld --bucket $CELLD_BUCKET &
celld deploy .
celld d1 migrations apply workspaces-dev . --bucket $CELLD_BUCKET
celld d1 migrations apply observability-dev . --bucket $CELLD_BUCKET
node ../../../experiments/selfhost-spike/runtime/seed-user.mjs ../secrets.json   # seed.sql + token.txt
celld d1 execute workspaces-dev --file ../seed.sql . --bucket $CELLD_BUCKET
curl -X POST http://127.0.0.1:8791/api/auth/token-login -H 'content-type: application/json' -d "{\"token\":\"$(cat ../token.txt)\"}"
curl http://127.0.0.1:8791/__spike/runtime          # feature probe
```

## What works (verified by running)

Unless noted, everything below ran on the real node. Raw log: `notes.md`. Evidence: `evidence/`.

| Area | Result |
|---|---|
| Bundling | celld's esbuild bundles `apps/api` in 3-4 s (29.4 MB, 5.6 MB gzip). It needed **no** `[alias]` unicorn-magic shim, no `no_bundle` and no pre-bundle. Mastra imports and runs. |
| Container classes without containers | The Worker loads with `SandboxDO` and `VmAgentContainer` exported and bound as plain SQLite DOs. Calling either throws "Containers have not been enabled…" in the constructor (`evidence/container-classes-without-runtime.json`). |
| Deploy | `celld deploy` takes about 6 s; the node adopts the new version in place, 1-26 s later, with no restart. |
| D1 migrations | All 249 main and 2 observability migrations apply (9.8 s). The ledger is wrangler-compatible (`d1_migrations`); 155 tables. |
| `/health` | 200, p50 3 ms. |
| Sign-in | `POST /api/auth/token-login` returns a better-auth session cookie. `GET /api/auth/get-session` works. The KV-backed rate limiter sets its headers. |
| Projects | `GET /api/projects`, `GET /api/projects/:id` work against a seeded project. Creating one needs a git host; see F9. |
| Chat sessions | `POST /api/projects/:id/sessions` returns 201 in 0.6 s on the first ProjectData activation, with DO SQLite migrations and `blockConcurrencyWhile`. List, detail and messages endpoints work. |
| Messages | `POST …/prompt` persists the user message and enqueues a durable delivery. The mailbox processes it about 1 s later and correctly reports `wake_failed: sleeping_snapshot_missing`, since there is no node. `persistMessageBatch`, the VM-agent write path, stores 1000 messages (a third with 2 KB of tool content) in 933 ms, 47-176 ms per 100-message batch. A replay counts as a duplicate (`evidence/persist-batch-1000.json`). |
| Project WebSocket | `GET /sessions/ws` goes through `projectDataService.forwardWebSocket`: ping/pong works, and `message.new`, `mailbox.enqueued`, `session.wake_failed` and `mailbox.delivery_updated` arrive live (`evidence/ws-prompt-broadcasts.log`). |
| Cron trigger | celld's own `*/5` trigger fired on schedule (13:05, 13:10…), with `cron.completed failedSweeps=[]` (`evidence/cron-completed-first-tick.log`). The daily `0 3 * * *` and hourly `30 * * * *` crons ran through SAM's real `scheduled()` via the probe. The daily jobs all completed; for the hourly one see F14. |
| SAM agent (`@mastra/core`) | With an OpenAI-compatible base URL patch (P3) and a local mock LLM, a full durable turn completes. 18 tools are sent and the reply streams back over SSE. Tool calls `sam_projects_list` and `sam_chats_list` run (reading D1 and ProjectData) and their results go back to the model. `AiTokenBudgetCounter` DO updates (`evidence/sam-agent-turn-stream.log`, `mock-llm-requests.log`). |
| `@cloudflare/workers-oauth-provider` | Discovery 200, dynamic client registration 201 (KV), `/oauth/authorize` 302 to consent. Requires the request URL to be `https://api.${BASE_DOMAIN}`; see F12. |
| GET crawl | 302 paths referenced by the web client (`get-crawl.mjs`). Results: 102×200, 182×404 (fake ids), 6×400, 5×401, 3×403, 3×500, 1×503. Every 5xx is a Cloudflare or GitHub service dependency (F13). |
| Latency (1 node, local bucket) | Authed GETs p50 20-33 ms, p90 28-42 ms: get-session, projects, sessions, messages, dashboard. |
| Memory | celld RSS 318 MB after the whole session; MinIO 172 MB. |
| Outbound fetch | HTTPS to public hosts works (api.cloudflare.com, gateway.ai.cloudflare.com). http to loopback works (mock LLM, ws echo). |

### Known-risk checklist (task step 5)

| Risk | Result | How verified |
|---|---|---|
| better-auth | Works: session create, get-session, cookie signing | Running |
| drizzle-orm/d1 | Works on every route exercised (sign-in, projects, sessions, tasks insert/update, crons). Raw D1 `batch` and `meta.changes` were checked by the probe; I did not confirm that a drizzle `.batch` call site ran. | Running |
| @mastra/core | Works: agent stream, tool registry, tool execution | Running |
| jose | RS256 sign/verify of callback and terminal tokens; a tampered token is rejected | Probe |
| @cloudflare/workers-oauth-provider | Works behind https forwarding | Running |
| @cloudflare/containers, @cloudflare/sandbox | Import and class load are fine. Without `[[containers]]` the first call throws in the constructor. Running containers was not tried; Track C did. | Running |
| `node:crypto` | `createHash` (SAM's only `node:crypto` use, in archive hashing), `createHmac` and `randomBytes` OK. `createCipheriv` is **not implemented** (nothing in SAM uses it). `AsyncLocalStorage`, `Buffer`, `zlib.gzipSync`, `CompressionStream` OK. | Probe |
| D1 batch atomicity | A 2-statement batch with a PK violation in statement 2 throws and rolls back statement 1. `celld d1 execute --file` is also atomic. | Probe |
| `meta.changes === 1` CAS | Hit = 1, miss = 0. **Divergence:** a writing trigger is not counted (F7). | Probe |
| `withSession` feature-detect (`lib/d1-session.ts`) | `withSession` exists, so SAM's session facade is used. The bookmark is always `celld:primary`. The fallback branch is not exercised on celld. | Probe |
| ProjectData DO SQLite migrations | Ran on first activation | Running |
| `ctx.storage.sql.databaseSize` | 57344 on the probe DO | Probe |
| `transactionSync` | Rollback on throw and commit both behave | Probe |
| `blockConcurrencyWhile` | Constructor work completes before the first RPC | Probe |
| Alarms firing | Fired 2 ms after `scheduledTime`, with `{retryCount:0,isRetry:false}`. The ProjectData mailbox runs. | Probe + running |
| DO RPC | Works. **Divergence:** custom error properties survive (F8). | Probe |
| Hibernatable WebSockets | `acceptWebSocket` with tags, `getTags`, `getWebSockets(tag)`, serialized attachments, `setWebSocketAutoResponse`, and alarm-to-tagged broadcast all work. Real hibernation was **not observed** (F11). | Probe (`evidence/ws-probe-hibernation.log`) |
| KV | `put` with TTL and metadata, `get`, `getWithMetadata`, json, `list`, `delete` | Probe |
| R2 | put/get/head, range, list, conditional get, delete, multipart (5 MiB + tail) | Probe |
| WebCrypto | AES-GCM (SAM `encrypt`/`decrypt`), HMAC-SHA256, Ed25519 (SAM deploy signing plus a generated key pair), ECDSA P-256 (VAPID), RSA-OAEP/PSS and ECDH keygen | Probe |
| `AI` absent | `/api/agent-models/catalog` returns a clean 503. `/api/transcribe` returns 500 (no flag). `/api/tts/synthesize` returns 500 and leaks `Cannot read properties of undefined (reading 'run')`. The SAM agent is unaffected: it uses AI Gateway over HTTP, not the binding. | Running |
| `ANALYTICS` absent | Per-request middleware is null-guarded, so no effect. `/api/admin/analytics/{dau,funnel}` return 500 (they need the Analytics Engine SQL API). | Running |
| `ARTIFACTS` absent | `/api/config/artifacts-enabled` reports `false`. Creating an artifacts project returns 400 "not enabled". | Running |
| `SANDBOX` bound, no runtime | `/api/agent-credential-setup-sessions/config` reports **`enabled: true`**, so a broken feature is advertised (F15). | Running |
| `VM_AGENT_CONTAINER` bound, no runtime | `/api/config/instant-runtime` reports `false` because `CF_CONTAINER_ENABLED` is unset in the top-level config. The deploy generator sets it to `true`. | Running + code |

## Failures

Root-cause categories: **config** (unsupported config key or shape), **node-compat** (Node
compatibility in a dependency), **binding** (missing binding), **celld** (celld bug),
**SAM** (SAM assumption).

| # | Symptom | Category | Minimal fix (spike patch where applied) |
|---|---|---|---|
| F1 | celld rejects `wrangler.toml` and the top-level keys `port`, `limits`, `alias`, `ai`, `analytics_engine_datasets`, `artifacts` | config | Generator emits `wrangler.json` and drops them (P1). `limits.cpu_ms` has no celld equivalent; `CELLD_HANDLER_BUDGET_S` exists but its default is undocumented. |
| F2 | Migrations: `new_classes` is not accepted (7 legacy classes) | config | Fold them into `new_sqlite_classes` (P1), as `durable-object-migrations.ts` already does on clean installs |
| F3 | `Error: config main must be a path inside the project` | config | Symlink `apps/api/src` into the project dir; celld accepts the symlink (P1) |
| F4 | `Error: two r2 bindings name the same bucket: "workspaces-dev-assets"` | config / SAM | SAM binds `R2` and `PROJECT_DATA_ARCHIVE_R2` to one bucket, in production too (`sync-wrangler-config.ts:1240`). Give the archive its own bucket name (P1); the data is prefix-separated anyway. |
| F5 | `celld d1 migrations apply`: "./src/db/migrations/observability holds .sql files, and celld reads migrations from a flat directory only" | config / SAM | SAM nests the observability DB's migrations inside the main DB's directory. Use flat per-DB directories (P1 symlinks), or move `observability/` out of `src/db/migrations` for real. `migrations_dir` must also be inside the project with no `..`. |
| F6 | `celld d1 …` cannot target `celld dev` (documented) | celld (by design) | Use a real node plus bucket even for local work, or accept that `celld dev` cannot be migrated |
| F7 | `UPDATE` with an `AFTER UPDATE … INSERT` trigger reports `changes=1` (`rows_written=2`). Cloudflare D1 counts trigger rows (apps/api rule 31: `changes:3`). | celld (divergence) | Harmless for SAM, which forbids writing triggers on CAS tables (migration 0219), but celld cannot catch that class of bug. Also documented: read-only statements report `changes=0`. |
| F8 | DO RPC errors keep custom `code`/`status`/`name`; Cloudflare keeps only `name` and `message` (apps/api rule 63) | celld (divergence) | Code that relies on `.code` passes on celld and fails on Cloudflare; the reverse is safe. Keep testing on workerd/Cloudflare for RPC error shapes. |
| F9 | Every `POST /api/projects` path needs GitHub, GitLab or Cloudflare Artifacts | SAM | Not celld-specific. A self-host needs a GitHub App, or a self-hostable git provider (generic git, Gitea), for the zero-config path. The spike seeded rows. |
| F10 | **Worker proxying an outbound WebSocket:** returning `fetch(upstream, {Upgrade})` as-is or re-wrapped makes celld send `101` with no `Upgrade`/`Connection`/`Sec-WebSocket-Accept`; clients fail with 1006. The upstream connection does open. | **celld** | Blocker for terminal, agent, log and port-preview WebSockets (`index.ts:590/712/723` shapes). Reproduced on the real node (`/__spike/ws-proxy`, `evidence/ws-outbound-proxy-101.log`). Fix in celld, or bridge in the Worker with `WebSocketPair` + `accept()` + pump + `ctx.waitUntil`; Track B verified the bridge in `celld dev`. DO-originated WebSockets are fine. |
| F11 | Real hibernation not observed: with `CELLD_IDLE_EVICT_S=5` and 25 s idle, a DO holding two hibernatable sockets kept the same instance | unknown | Not a failure. Docs say sockets survive hibernation on the same node but **close when the cell moves** (node stop or rebalance), so clients must reconnect; SAM's web client already does. |
| F12 | `workers-oauth-provider` returns 404/400 over plain http | config | It matches `https://api.${BASE_DOMAIN}`. Run behind a TLS proxy with `CELLD_TRUST_FORWARDED_HEADERS=1`; verified with `X-Forwarded-Proto/Host`. |
| F13 | `/api/admin/analytics/dau` and `funnel` return 500 | binding / SAM | They query the Analytics Engine SQL API with `CF_ACCOUNT_ID`. Need a "not available" state, or gate on `ANALYTICS`. |
| F13b | `/api/agent-models/catalog` returns 503 "Workers AI binding (AI) is not configured" | binding | Clean failure. The model catalog needs a non-Cloudflare source (static or OpenAI-compatible `/models`). |
| F13c | `/projects/:id/repository-access/discover` returns 500 | SAM (test data) | GitHub API with a fake installation; expected in the spike |
| F14 | Hourly cron (`30 * * * *`, monthly cost aggregation) calls the AI Gateway logs API. With dummy `CF_*` values a request went to api.cloudflare.com (404); with them unset it logs `CF_ACCOUNT_ID is not configured` at **error** level every hour. The usage-budget path logs `usage.budget_gateway_error` the same way. | SAM | `AI_GATEWAY_ID="sam"` is a `wrangler.toml` default. Skip the AI Gateway paths when `CF_ACCOUNT_ID` or `AI_GATEWAY_ID` is unset. |
| F15 | Guided credential setup is advertised (`/config` returns `enabled:true`) with no container runtime; sessions would fail (`sandbox_provision_failed`) | SAM | Gate `guidedSetupAvailable` on `SANDBOX_ENABLED`, not on the binding existing (`agent-credential-setup-sessions.ts:86`) |
| F16 | `POST /api/transcribe` returns 500. `POST /api/tts/synthesize` retries, then returns 500 with `Cannot read properties of undefined (reading 'run')`. | binding / SAM | Add a flag or binding guard for transcribe; default `TTS_ENABLED` off when `AI` is absent |
| F17 | SAM agent model URL `https://gateway.ai.cloudflare.com/v1/undefined/sam/workers-ai/...` when `CF_ACCOUNT_ID` is unset | SAM | An OpenAI-compatible base URL setting (P3, 3 lines); model ids also need to be configurable (default `@cf/zai-org/glm-5.3-flash`) |
| F18 | `compatibility_flags` `nodejs_compat` and `unhandled_rejection_after_microtask_checkpoint` are accepted but have no effect (documented; celld honours only five flags) | celld (divergence) | Node built-ins load anyway (partial). The unhandled-rejection timing difference is untested. |
| F19 | Node SIGTERM takes ~16 s; an immediate restart hits `Address already in use` | celld | Restart with retry (matches Track C) |
| F20 | Inferred from code by a background survey, not run: with `AI` absent, the stalled-task classifier (5-min cron, default on) throws while building a `Promise.race`, leaving a 10 s timer that rejects unhandled once per classified task (`stalled-task-classifier.ts:282-312`) | SAM | Guard `env.AI` before building the race, or default the classifier off without `AI` |

### Patches on this branch

| Patch | Files | Purpose |
|---|---|---|
| P1 | `experiments/selfhost-spike/runtime/gen-wrangler-json.mjs` | `wrangler.toml` → celld `wrangler.json`. Drops unsupported keys, folds `new_classes`, renames the duplicate R2 bucket, builds flat D1 migration directories. `--probe` adds the probe DO; `--var` overrides vars. |
| P2 | `apps/api/src/spike-probe.ts`, 4 lines in `apps/api/src/index.ts` | `/__spike/*` (404 unless `SPIKE_PROBE=true`): `runtime` feature probe, `scheduled` invoker, `persist-batch`, `containers`, `ws` (probe DO), `ws-proxy`, `alarm-status`, plus the `SpikeProbeDO` class. Spike only, not for main. |
| P3 | `apps/api/src/services/ai-proxy-shared.ts` (+3 lines) | `SPIKE_OPENAI_COMPAT_BASE_URL` overrides `buildWorkersAIGatewayUrl`, so the SAM agent can use any OpenAI-compatible endpoint |
| Helpers | `gen-throwaway-secrets.mjs`, `seed-user.mjs`, `node-env.sh`, `ws-listen.mjs`, `ws-probe.mjs`, `get-crawl.mjs`, `mock-llm.mjs`, `ws-echo-server.cjs` | Throwaway tooling |

No SAM business logic was changed for the Worker to boot. P2 and P3 are test scaffolding.

## Not exercised (unknown)

- **A real VM node.** Provisioning, heartbeats, callbacks with a real callback JWT through
  `POST /api/workspaces/:id/messages`, and the WebSocket proxy to a live vm-agent. JWT verify and
  the batch write path were exercised separately.
- **Containers on celld:** Instant and the sandbox. They need Docker on the node, plus images built
  from `Dockerfile.sandbox` and `Dockerfile.vm-agent-container`. The latter depends on CI-built
  artifacts. Track C found the nftables fence blocks a container from calling back to the host.
- **Real sign-in providers:** GitHub, Google and GitLab OAuth need real apps. Email OTP needs
  Cloudflare `send_email`, so it is unusable off Cloudflare.
- **Static web UI from the Worker** (`assets`). Track C verified the pattern with a small Worker.
- **Multi-node fleets**, cell moves, real hibernation and eviction (F11), and long-run storage
  growth (Track C: set `CELLD_LTX_RETENTION_SECS`).
- **Load beyond single-client sequential requests.** CPU limits: `[limits] cpu_ms` is dropped and
  `CELLD_HANDLER_BUDGET_S` defaults are undocumented.
- **The `withSession` fallback branch.** celld provides `withSession`, so the fallback never runs.
- **Agent email** (`email()` handler; Email Workers are unsupported by celld), D1 Time Travel
  replacements, and Workers Observability log queries.
- **Version drift:** v0.6.3 exists and fixes a restart-empty bug, per Track C; the spike pinned 0.6.2.

## Verified vs inferred

- **Verified by running:** everything in "What works", the risk checklist rows marked Running or
  Probe, and F1-F17 and F19.
- **Inferred from docs or code:**
  - F18 (flag no-op), from the celld compatibility docs;
  - F20 and the rest of the binding call-site survey (`apps/api/src`, background agent);
  - the `RETURNING`-cursor rule: SAM's DO `RETURNING` sites use `.toArray()`/`.one()`, so the
    unfinished-cursor rejection should not trigger;
  - D1 temporary objects and `BEGIN`/`SAVEPOINT`: no SAM runtime SQL uses them (grep);
  - `dump()` throws on celld: only `lib/d1-session.ts` delegates to it, and nothing calls it in
    production code.

## Open questions

1. Will celld fix returning a fetched upgrade response (F10), or does SAM adopt a Worker-side
   WebSocket bridge for every node proxy path? The bridge costs Worker/DO time per open socket.
2. What is the default `CELLD_HANDLER_BUDGET_S` and `CELLD_FETCH_TIMEOUT_S`, and do they cut SAM's
   long-lived SSE (SAM turns) and WebSocket relays?
3. Should SAM keep one `wrangler.toml` and generate both Cloudflare and celld configs (the generator
   approach), or move to `wrangler.jsonc` as the source of truth?
4. Is the D1 trigger-count divergence (F7) acceptable as a dev target, given SAM's tests must still
   run on workerd to catch it?
5. Which git provider is the zero-Cloudflare default for project creation (F9)?
