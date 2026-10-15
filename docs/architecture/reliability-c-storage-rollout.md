# Reliability C storage rollout

MCP admission uses a dedicated SQLite `McpRateCounter` per existing task/agent-session/workspace fallback identity. Boot logs use a dedicated `WorkspaceBootLog` per workspace. Neither adds traffic to ProjectData. Wrangler migration v22 adds both SQLite classes and bindings; generated environments copy these top-level bindings. Existing installations append v22; new installations replay the unchanged earlier migrations plus v22.

## Shared activation and initial legacy retirement

**Activation remains blocked until the coordinator proves retirement of all prebridge invocations and deferred KV work.** Routing 100% of new traffic to the bridge and waiting a fixed interval does not prove this: a connected HTTP invocation can retain a request body indefinitely. This bridge cannot fence binaries deployed before it. Do not publish the activation record or claim production readiness without a concrete cancellation/drain boundary. Keep bridge KV ownership while this prerequisite is unresolved.

All corrected bridge versions read the same deployment-owned `platform_settings` record, key `reliability.storage.activation.v1`, through a fresh `DATABASE.withSession('first-primary')` query. Missing records mean KV bridge mode; database errors, malformed records, and window mismatch fail closed. Neither absence nor activation is cached. Per-version `MCP_RATE_COUNTER_CUTOVER_AT` and `BOOT_LOG_STORAGE_CUTOVER_AT` are no longer authoritative and must not be used to activate storage.

After verified prebridge retirement, the coordinator publishes the record exactly once using an atomic insert. Fields are Unix seconds: `publishedAt`, `rateCutoverAt`, `bootLogCutoverAt`, and `windowSeconds`. Both cutovers must be strictly later than publication; the rate cutover must align with the frozen window. Use this parameterized statement against the primary database (parameters supplied by the coordinator, never hardcoded in source):

```sql
INSERT INTO platform_settings (key, value)
SELECT 'reliability.storage.activation.v1', json_object(
  'publishedAt', unixepoch(), 'rateCutoverAt', ?1,
  'bootLogCutoverAt', ?2, 'windowSeconds', ?3)
WHERE ?1 > unixepoch() AND ?2 > unixepoch() AND ?3 > 0 AND ?1 % ?3 = 0
;
```

Read back and verify the exact immutable record before proceeding. A zero-row insert is not evidence of successful publication. Migration0196 rejects updates, deletes, conflicting inserts, and INSERT OR REPLACE for this key, including generic settings helpers; an existing record must be read and verified rather than overwritten. Never update, delete, reschedule, or replace a published record; freeze rate-window size and identity derivation. The SQL examples in tests replace records solely to isolate fixtures, not as an operational procedure.

MCP pins `now`, window start, and reset before awaiting shared configuration. An old env-unset bridge held at the request body therefore consults the same record when it eventually reaches admission. A lookup that began before publication keeps its prepublication window even if it resumes after activation. The current window remains KV-owned until its reset; new windows are DO-only, without seeding or fallback.

All bridge boot-log reads, appends, replacements, and clears go through the same workspace DO even before activation. Its lock spans primary configuration lookup and the full awaited legacy KV operation. A legacy put cannot overtake an activated clear. Clears/replacements persist their SQLite view and legacy suppression marker even before activation, with later bridge appends ordered in that view and mirrored to KV until activation. SQLite clears/replacements retain their durable legacy suppression marker so delayed KV visibility cannot resurrect cleared data. Legacy records retain their original KV TTL; no postactivation hot KV writes occur.

## Rollback and abort

Before publication, remain in KV bridge mode if legacy retirement cannot be proven. After publication, only roll back to a corrected bridge that consults the same primary record and preserves bindings, DO protocol, rate window and identity derivation. Per-version timestamps, an uncorrected C bridge, or a prebridge KV-only binary are not compatible rollback artifacts. Do not delete namespaces or reuse migration tags. A failed deployment never permits falling back to KV after activation; forward-fix with the immutable record intact.

## Retention and deduplication

Rate count is capped at the configured limit; one row per live window, expired rows removed on admission/alarm. Log entries are capped by `BOOT_LOG_MAX_ENTRIES` (default 50), and receipt-based inactivity expiry uses `BOOT_LOG_TTL_SECONDS` (default 1800). Clears and expiry retain one small metadata row per workspace, not log payloads. No periodic global sweeps or new timers are added.

A retry with the same original timestamp and identical step/status/message/detail is deduplicated while that entry is retained. Distinct payloads remain distinct; retries without an original timestamp cannot be recognized (the existing callback supplies server time). Identical legitimate events in the reporter's second-resolution timestamp collide; the log is a bounded provisioning progress view, not an audit ledger. The Go reporter and callback authentication contract are unchanged.

## Consolidated staging evidence required

Coordinator pins the final integrated head and runs one shared sweep: bridge unset and existing KV records; migrations/bindings on clean and existing installs; shared-record future activation and last KV window; held-body env-unset bridge regression; delayed legacy KV put versus activated clear; concurrent MCP bursts with exact admission/header checks and fallback identities; restart without quota reset; mixed compatible versions and rollback after consumed quota; callback started/completed burst, retry dedupe, cap/TTL, clear before import and after restart, legacy read compatibility and no new hot KV writes; injected DO failures fail closed. Provision one normal configured-pool VM to generate real callbacks, verify heartbeat/workspace access, then clean it up. Shared staging remains coordinator-owned; no separate C deployment.

Cloudflare references: [SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
