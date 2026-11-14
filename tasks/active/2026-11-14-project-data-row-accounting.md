# ProjectData per-operation row accounting

Attribute SQL and storage writes to RPC and handler labels without adding persisted writes. Scope is only the accounting item in idea 01M7CX61WVX72T7CFQNRTX0DVM.

## Research
- `packages/project-data/src/do/index.ts` centralizes all public RPC methods, handler methods, SQL, and storage access.
- `alarm-sections.ts` already observes alarm SQL cursors and emits section totals; preserve its log schema.
- Real workerd worker tests are required for SQLite cursor counters. Local better-sqlite3 unit tests cannot establish billed row counts.
- Runtime settings must use admin registry where practical; no new Worker vars or migrations.

## Checklist
- [ ] Bounded SQL cursor folding and label accounting for SQL/KV/alarm writes.
- [ ] Central RPC wrapping preserving this, synchronous returns and errors, nested calls and async work.
- [ ] Alarm sections, fetch and WebSocket labels; preserve existing section totals.
- [ ] In-memory interval aggregation, ranked bounded labels and dropped disclosure, no persistence.
- [ ] Optional last complete UTC day row writers report; unavailable on failed telemetry query.
- [ ] Real stub RPC tests: message batch, events, heartbeats, alarm, no extra writes.
- [ ] Cadence, reset, cap, sync/error tests and guard discrimination.
- [ ] Validation, specialist review, coordinated staging chat/log proof.
- [ ] PR/CI/CodeRabbit/merge; production smoke/query; first full hour idea note/checkoff.

## Acceptance
Every SQL/storage write has a label, memory stays bounded, existing behavior and cleanup protections remain intact, accounting adds zero database rows. No changes to scheduled/project-data-archive-sharding.ts or github-project-event-producer.ts.

User requires primary checkout on assigned output branch, superseding /do worktree instructions. Existing `.codex/config.toml` edits belong to the workspace and must be preserved.
