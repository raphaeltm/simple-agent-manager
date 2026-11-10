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

- [ ] `scripts/selfhost/celld-config.ts`: pure translation wrangler.toml -> celld wrangler.json,
      with an explicit per-key translation table that throws on unknown keys
- [ ] Reuse `resolveDurableObjectMigrations` for new_classes folding
- [ ] Distinct R2 bucket names; flat per-database migration dirs (symlinks, real ones untouched)
- [ ] Omit `[[containers]]`; keep container DO bindings; keep crons
- [ ] Self-host overrides: Cloudflare-only switches off
- [ ] `assets` with SPA fallback + `run_worker_first: true`; `_headers` shipped with the build
- [ ] Unit tests for the generator (real wrangler.toml + synthetic unknown-key failure)
- [ ] `resolvePagesProxyTarget` gains an `assets` target when ASSETS is bound; index.ts dispatch
- [ ] Tests: ASSETS present serves app host; ASSETS absent keeps Pages behaviour; api/ws hosts unaffected
- [ ] `generate-keys.ts`: export generators, keep CLI behaviour
- [ ] `scripts/selfhost/deploy.ts`: keys (generate once, root-only, keep), render vars, celld deploy,
      delete rendered file, apply both D1 migration sets, idempotent
- [ ] `deploy/selfhost/`: docker-compose.yml, Caddyfile, sam.d placeholders, frps placeholder,
      .env.example, pinned images/binaries
- [ ] CI: run selfhost tests in the deploy-scripts job; path filter
- [ ] Local proof: stack up with local CA, deploy real Worker + web, smoke sign-in, app host loads,
      chat session created, cron fires, celld RSS recorded
- [ ] PR body: verified vs not, celld version, open questions

## Acceptance criteria

- Cloudflare deployments unchanged: `sync-wrangler-config.ts` and `wrangler.toml` untouched;
  ASSETS dispatch is inert without the binding (test).
- Generator fails loudly on an unknown top-level key (test).
- Deploy script re-run is a no-op apart from a redeploy (keys preserved, migrations idempotent).
- Local proof steps recorded with evidence.
