# ProjectData per-operation row accounting

Implementation and local review complete. Staging, release, and first-hour observation remain in progress; this is not a release-completion record.

Attribute SQL and storage writes to RPC and handler labels without adding persisted writes. Scope is only the accounting item in idea 01M7CX61WVX72T7CFQNRTX0DVM.

## Research

- `packages/project-data/src/do/index.ts` centralizes all public RPC methods, handler methods, SQL, and storage access.
- `alarm-sections.ts` already observes alarm SQL cursors and emits section totals; preserve its log schema.
- Real workerd worker tests are required for SQLite cursor counters. Local better-sqlite3 unit tests cannot establish billed row counts.
- Runtime settings must use admin registry where practical; no new Worker vars or migrations.

## Checklist

- [x] Bounded SQL cursor folding and label accounting for SQL/KV/alarm writes.
- [x] Central RPC wrapping preserving this, synchronous returns and errors, nested calls and async work.
- [x] Alarm sections, fetch and WebSocket labels; preserve existing section totals.
- [x] In-memory interval aggregation, ranked bounded labels and dropped disclosure, no persistence.
- [x] Optional last complete UTC day row writers report; unavailable on failed telemetry query.
- [x] Real stub RPC tests: message batch, events, heartbeats, alarm, no extra writes.
- [x] Cadence, reset, cap, sync/error tests and guard discrimination.
- [x] Local validation and specialist review.
- [ ] Coordinated staging chat/log proof.
- [ ] PR/CI/CodeRabbit/merge; production smoke/query; first full hour idea note/checkoff.

## Acceptance

Every SQL/storage write has a label, memory stays bounded, existing behavior and cleanup protections remain intact, accounting adds zero database rows. No changes to scheduled/project-data-archive-sharding.ts or github-project-event-producer.ts.

User requires primary checkout on assigned output branch, superseding /do worktree instructions. Existing `.codex/config.toml` edits belong to the workspace and must be preserved.

## Measurements and implementation notes

- Assistant-message fixture with workspace/session state reproduces 19 SQL rows. Four user messages instead write 24 rows because of the partial user-content index and initial topic update.
- Cold event fixture: 9 event index/table rows + 4 initial scheduler rows + 2 persisted alarm-schedule rows + setAlarm = 16. Heartbeat: 1 SQL update + 1 persisted alarm-schedule update + setAlarm = 3. These fixture-specific totals include all existing scheduler writes, unlike the domain-only reference profile.
- Admin registry interval is read at startup and after each flush, using the existing isolate cache. No per-request D1 reads and no migrations or new Worker variables.
- Log uses ranked object slots (labels.rankN), so Observability can group scalar labels and sum their corresponding fields. Limit is 32 named labels plus other; counters retain the fixed method/section vocabulary, one pending cursor.
- Memory-only windows are lost on eviction; cursors consumed across other exec/await boundaries may have late reads omitted. Attribution does not replace billed counters.
- 2026-11-14 credential-aware `pnpm quality:cloudflare-cost` succeeded (job sx-bcdae620103645b34e44fbb18668facf5fb977e96826d1a8085f373801acccbe): 2026-11-13 2.32M installation DO SQLite rows written; MTD through 11-13 18.41M. Duration field is durableObjectsPeriodicGroups.sum.duration, no wallTime pricing. Initial plain shell 401 was placeholder credentials, not missing access.
- Focused real workerd tests: 20 passed across row usage, alarm sections, admin settings. Reporter 7 passed. Full checks in progress.

## Final local validation and review (2026-11-14)

- Full lint22tasks, typecheck36tasks, test39tasks, build18tasks pass. API15151tests pass (4skipped); ProjectData528tests pass; web5228tests pass.
- Final combined real workerd suites:21tests pass (row usage9, existing alarm sections7, admin settings5). Optional reporter14tests pass.
- Runtime tunable ratchet and diff whitespace checks pass.
- Cloudflare specialist, test engineer, task-completion validator, constitution validator, documentation synchronization review: PASS/ADDRESSED, no outstanding implementation findings.
- Guard discrimination: nine worker mutations (cadence, automatic flush, nested attribution, cap, ranking, constructor/accessor skip, single cursor fold, empty window) and five reporter mutations (unknown alias, limit, duplicate aggregate, metric completeness, HTTP status) each fail their intended test; original source restored and final suites green.
- Broader quality-script suite:899passed/8failed initially. Six audit failures were local EACCES under root-owned `.codex/tmp`; rerunning its suite with writable GITHUB_TRIGGER_AUDIT_OUTPUT passed40/40. Two dependency scanner failures are EACCES reading root-owned `.codex/tmp/arg0` (700). Exact base-commit test reproduced both failures, proving they precede this change; these files are unchanged. CI's clean checkout does not contain that local runtime directory.
- Read-only staging Workers Observability probe succeeded: known row sums grouped by `$metadata.service` return sam-api-staging; unknown rank fields correctly return empty aggregate arrays rather than fabricated zeros. API request shape verified against live service before release.
- Staging held by parent task01M7CVZNSP0EHV9BJ72HCFQJSC until its explicit release. Parent deploy43593297628 completed successfully; manual verification may still be active.
