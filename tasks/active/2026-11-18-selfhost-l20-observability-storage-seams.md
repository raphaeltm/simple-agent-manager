# Self-host landing slice L20: observability and storage seams

## Problem

The integration branch `sam/selfhost-pass-2` (tip 942d2c0a4) carries the observability and
storage seams a self-hosted (celld) box needs: a D1 product-analytics sink, a shared R2 S3
presign client that can target an operator S3 store, admin log notices for installs without
Workers Observability or a tail worker, and serving the web UI from an `ASSETS` binding. L20
lands them on `main` without changing any Cloudflare behaviour. Plan row: idea
01M72M9AEB933ZY8269D376DKC, LANDING PLAN part 6. Coordinator task 01M7JMXS2JRW6QQMB1356ENPM3.

## Findings to resolve (from M4 #2884 "Raised to the coordinator")

1. The analytics D1 sink migration sat in the shared observability migrations directory, so it
   would run on every Cloudflare install. Resolution: move it to
   `apps/api/src/selfhost/migrations/observability/0002_analytics_events.sql` (same filename, so
   the BOX's ledger entry still matches) with a projection list like L17a's
   `REVERSE_TUNNEL_MIGRATIONS`. Cloudflare's `migrations_dir` never sees it.
2. HIGH-5: capability inputs not in the 2026-11-16 production capture. Checked production
   `sam-api-prod` script settings on 2026-11-18 (names/types only): `ANALYTICS`
   (analytics_engine, dataset sam_analytics), `ANALYTICS_DATASET`, `CF_ACCOUNT_ID` and
   `CF_API_TOKEN` (secrets), `R2` (r2_bucket), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
   (secrets), `R2_BUCKET_NAME` plain text; no `ANALYTICS_SINK`, no `LOG_TAIL_AVAILABLE`, no
   `R2_S3_*`, no `ASSETS`; tail consumer `sam-tail-worker-prod` attached. So analyticsQuery,
   logSearch, liveLogStream and R2 presign all resolve true / to Cloudflare R2 on production.
   Pinned in tests with that exact shape.
3. Self-host-only runtime tunables (D1 sink retention days and row cap) go through
   `installAdminSettingDefinitions` from the self-host install point, not the base registry.

## Research Findings

- Branch sink: `services/analytics-d1-sink.ts` read `ANALYTICS_SINK="d1"`; consumers
  `middleware/analytics.ts`, `routes/analytics-ingest.ts`, `routes/admin-analytics-query.ts`,
  `routes/admin-analytics.ts`, `scheduled/observability-purge.ts`, `lib/analytics-config.ts`.
  Retention settings were in the base operations-telemetry group (finding 3).
- L14 precedent: `services/speech-backend.ts` is a shared extension seam; `selfhost/speech/`
  installs a backend and settings. The Cloudflare entry never imports `selfhost/`.
- Branch R2: `services/r2-presign-config.ts` + `services/r2-s3-client.ts`
  (`getR2PresignTarget`) replace main's two S3 clients (`r2-s3-client.ts` and
  app-deployment's `getS3Client`). Compose artifacts keep the SDK default checksum mode
  (main: explicit WHEN_SUPPORTED, which is the SDK default).
- Branch's `isAcceptableOperatorEndpoint` lives in a worker-core module main lacks; inline the
  same rule with main's `classifyHost`.
- Admin log notices: `BoxLogsNotice`, `AdminLogs`/`AdminStream` gate on public capabilities
  `logSearch`/`liveLogStream`; API refuses `/logs/stream` without a tail and log search without a
  Cloudflare account API (FEATURE_UNAVAILABLE).
- ASSETS: `lib/pages-proxy.ts` `assets` target, `index.ts` serves `app.*` from `ASSETS` when bound.
- Excluded (other slices): `compact-r2.ts` shared-flight joins, `conditional-r2` helper (key
  rotation), `app.ts` split, other capabilities (artifacts, email, sandbox, app deployments).
- Runtime-tunables gate needs bootstrap exceptions for `ANALYTICS_SINK`, `LOG_TAIL_AVAILABLE`,
  `R2_S3_*`.

## Implementation Checklist

- [ ] Shared seam `services/analytics-sink.ts` (AE default, installable local sink)
- [ ] `selfhost/analytics/` D1 sink, SQL translation, purge, settings, install point
- [ ] Move migration to `selfhost/migrations/observability/` + projection list
- [ ] Wire middleware, ingest, admin query/gate, purge, forward skip reason, dataset name
- [ ] Capabilities: analyticsQuery, workersObservability (logSearch), liveLogStream; public logSearch/liveLogStream
- [ ] Log stream and log search refusals (FEATURE_UNAVAILABLE)
- [ ] R2 presign config + shared client; attachments, snapshots, compose, build context, upload route
- [ ] app-deployment package takes a presign target
- [ ] ASSETS serving for app.* when bound
- [ ] Web: BoxLogsNotice on Admin → Logs / Stream
- [ ] Env declarations + runtime-tunables bootstrap exceptions
- [ ] Docs: configuration reference / env example
- [ ] Tests pinning Cloudflare branches (production capture) + self-host branches

## Acceptance Criteria

- [ ] Cloudflare: analytics writes go to Analytics Engine, admin analytics queries the SQL API,
      presigned URLs are `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`, app.* still
      proxies to Pages, log search and stream unchanged. Pinned by tests using the production shape.
- [ ] The analytics_events migration is not in any Cloudflare `migrations_dir`.
- [ ] Self-host settings are installed only by the self-host install point.
- [ ] STG: admin analytics, attachment upload and session snapshot all work unchanged on Cloudflare.
