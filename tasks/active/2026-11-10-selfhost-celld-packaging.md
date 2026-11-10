# Self-host pass 2, T1: celld packaging and runtime configuration

Coordinator task `01M72KTXWD8FJ0Z7TXKN5GF20J`; this task `01M72WZBV1QQVY2MMR7ZAT6FB6`.
Idea `01M72M9AEB933ZY8269D376DKC` (section 5). Integration branch `sam/selfhost-pass-2`.
Draft PR only, never main, no merge, no Cloudflare staging, no Cloudflare credentials.

## Problem

The spike proved the unmodified API Worker runs on celld, but the config translation,
web UI hosting, deploy flow and one-box stack exist only as throwaway scripts on spike
branches. Pass 2 needs real, tested, re-runnable packaging that a later task can run on a
real GCP VM.

## Research findings

- `apps/api/wrangler.toml` top-level keys: name, main, compatibility_date,
  compatibility_flags, port, limits, alias, vars, artifacts, d1_databases, kv_namespaces,
  r2_buckets, durable_objects, migrations, containers, analytics_engine_datasets, ai,
  triggers. celld rejects port, limits, alias, artifacts, analytics_engine_datasets, ai.
- Seven legacy `new_classes` migrations (v2, v3, v4, v6, v8, v15, v17). celld only accepts
  `tag` + `new_sqlite_classes`. `resolveDurableObjectMigrations(migrations, null)` in
  `scripts/deploy/durable-object-migrations.ts` already folds them for a clean install.
- `R2` and `PROJECT_DATA_ARCHIVE_R2` share one bucket name; celld refuses that.
- The observability migrations directory is nested inside the main one; celld needs flat
  directories inside the project dir (no `..`).
- `main` and `assets.directory` must be inside the project dir.
- `generate-keys.ts` keeps its generators private and runs `main()` on import, so it
  cannot be reused without a small export refactor (local-dev script; Cloudflare pipeline
  never runs it, CI only `tsx --check`s it).
- Host dispatch for `app.` lives in `resolvePagesProxyTarget` (`apps/api/src/lib/pages-proxy.ts`).
  Adding an `assets` target there keeps one dispatch function.
- celld has no secrets mechanism: secrets go into `vars` at deploy and land in plaintext in
  `deploy/<worker>/<version>/manifest.json` in the bucket.
- celld supports `gs://` with Application Default Credentials natively (`celld --help`).
- Worker fetch to `127.0.0.1:{leasePort}` runs in celld's netns and Caddy forward_auth
  proxies to the same port, so caddy, celld and frps must share one loopback (host network).
- Web build needs `VITE_API_URL=https://api.${BASE_DOMAIN}`.

## Implementation checklist

- [x] `scripts/selfhost/celld-config.ts`: pure translation wrangler.toml -> celld wrangler.json,
      with an explicit per-key translation table that throws on unknown keys
- [x] Reuse `resolveDurableObjectMigrations` for new_classes folding
- [x] Distinct R2 bucket names; flat per-database migration dirs (symlinks, real ones untouched)
- [x] Omit `[[containers]]`; keep container DO bindings; keep crons
- [x] Self-host overrides: Cloudflare-only switches off
- [x] `assets` with SPA fallback + `run_worker_first: true`; `_headers` shipped with the build
- [x] Unit tests for the generator (real wrangler.toml + synthetic unknown-key failure)
- [x] `resolvePagesProxyTarget` gains an `assets` target when ASSETS is bound; index.ts dispatch
- [x] Tests: ASSETS present serves app host; ASSETS absent keeps Pages behaviour; api/ws hosts unaffected
- [x] `generate-keys.ts`: export generators, keep CLI behaviour
- [x] `scripts/selfhost/deploy.ts`: keys (generate once, root-only, keep), render vars, celld deploy,
      delete rendered file, apply both D1 migration sets, idempotent
- [x] `deploy/selfhost/`: docker-compose.yml, Caddyfile, sam.d placeholders, frps placeholder,
      .env.example, pinned images/binaries
- [x] CI: run selfhost tests in the deploy-scripts job; path filter
- [x] Local proof: stack up with local CA, deploy real Worker + web, smoke sign-in, app host loads,
      chat session created, cron fires, celld RSS recorded
- [x] PR body: verified vs not, celld version, open questions

## Acceptance criteria

- Cloudflare deployments unchanged: `sync-wrangler-config.ts` and `wrangler.toml` untouched;
  ASSETS dispatch is inert without the binding (test).
- Generator fails loudly on an unknown top-level key (test).
- Deploy script re-run is a no-op apart from a redeploy (keys preserved, migrations idempotent).
- Local proof steps recorded with evidence.

## Implementation notes

- A fresh celld fleet reports `no node leases` to `celld d1` until the first `celld deploy`
  (verified on 0.6.3 with a running node). The deploy script migrates first on upgrades and
  deploys-then-migrates on a fresh fleet.
- `celld deploy` prints binding names, not values; secrets never reach the deploy log.
- Content-addressed deploys: an unchanged re-deploy yields the same version ID.
- Chromium refuses the service-worker script over Caddy's local CA even with
  `ignoreHTTPSErrors`; a real certificate removes those two console errors.
- `VM_AGENT_TRANSPORT=reverse-tunnel` is set by the generator but main's node-tunnel-config
  rejects it until T2's transport merges; the branches must land together.

## Local proof evidence (celld 0.6.3, 2026-11-10)

- Stack: profiles tunnel + local-store, `tls internal`, SAM_DOMAIN=sam.test.
- Fresh deploy: 252 D1 migrations applied (main + observability), Worker 29.4 MB bundle,
  434 static asset files (8.2 MB).
- `https://api.sam.test/health` 200; app deep link served from ASSETS with zstd; `/oauth/consent`
  carries `_headers` CSP/X-Frame-Options/no-store; `api.sam.test/index.html` 404 JSON;
  ws-* host 401 from the workspace proxy.
- Spoofed CF-Connecting-IP/X-Forwarded-For/True-Client-IP ignored: KV rate-limit key used 127.0.0.1.
- Smoke token-login 200, get-session, projects list, POST sessions 201; session visible in the
  real web UI (screenshots in `.codex/tmp/playwright-screenshots/selfhost-*`), zero 5xx.
- Cron `*/5` fired at 14:50 with `failedSweeps=[]`; zero error-level logs.
- celld RSS 303 MB (cgroup 311 MiB) with the real Worker; MinIO 173 MiB; Caddy 67 MiB; frps 12 MiB.
- Re-deploy: migrations first ("No migrations to apply"), same version ID, keys unchanged,
  data and sessions preserved. `docker compose restart celld`: 16 s, serving 2 s after start.
