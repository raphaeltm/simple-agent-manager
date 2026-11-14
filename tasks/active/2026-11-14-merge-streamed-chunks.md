# Merge streamed agent chunks into fewer Durable Object rows

Task: 01M7E19YHSJ73896Q84ASSGFDN
Output branch: sam/store-streamed-agent-replies-ssgfdn
Research base: current main 4bdaaf61f6cecb83b6a3bab30e011257ea019710 (#2740).

## Problem

Streamed replies insert one raw row per chunk, paid again during archive reclaim.
Reduce physical writes without changing content, IDs, ordering, cards, limits, search or archive correctness.

## State: Part 1 identity decision gate; no implementation

- Session credential name and session limits reported through SAM before research.
- Read idea 01M7CX61WVX72T7CFQNRTX0DVM, requested profile notes, and Library archive-decisions.html.
- `sessions_read messages` groups raw chunks even with all roles. Original raw-sampling premise is false: `packages/operations/src/chat-core.ts:112`.
- Parent acknowledged premise and suggested production D1 archive checkpoint counts (peer event 91ed29fa-8af4-48ce-ad2d-6fccc43c4f38).
- Read-only production query at 2026-11-14T22:19:39Z: 2,776 published complete raw/grouped pairs. Exclude 1,013 with zero grouped inventory. Remaining 1,763 have 4,588,980 raw / 332,614 grouped rows. Ratios are representation density, NOT proven safe merge savings.
- 25-example sample (10 Claude Code, 10 Codex, 5 OpenCode inferred from retained workspace harness): 414,898 raw / 13,427 grouped rows. OpenCode examples are older; attribution can be ambiguous. Counts-only report in Library /engineering/cost/part1.md.
- Existing Go Reporter synthetic fixture independently counted: assistant 1,785 / 105 runs of 17; user 105; tools 210; thinking/plan/system 0. Assistant-only packing yields 420 physical rows. At unchanged 42 batches: model 6,594 -> 1,575 SQL writes, -76.11%, not workerd-measured candidate.
- **Later-chunk IDs are intentionally referenced.** `apps/web/src/components/project-message-view/message-aliases.ts:1-15` documents MCP and page-boundary comments on later chunks. `types.ts:253` chooses first loaded ID; `comments.ts:95` validates every raw ID; `message-context.ts:186` locates them.
- Keeping only the first ID breaks supported references; stop and ask per explicit task constraint.
- Recommended option to evaluate: server-packed constituents preserving every original ID, timestamp, sequence, metadata and boundary, with expansion through all raw readers. Cross-cutting format/lookup design needs approval before selection. Alias rows add writes and erase source-delete savings; an added alias index makes fixture ingest savings only 25.16%.
- Server path is required for old agents. No Go rollout-dependent solution. Preserve wire streaming and original chunk broadcasts.
- Full compatibility matrix and options are in Library report. No production/app code or wrangler changes made; no staging resources created. Unrelated baseline .codex/config.toml modification preserved.

## Implementation checklist (pending approval and final Part 1 + 20 minutes)

- [ ] Choose approved identity-preserving design; resolve bounded exact-ID lookup and billed read cost.
- [ ] Confirm >=40% safe real-data reduction with appropriate production/staging evidence; do not substitute grouped density.
- [ ] Server merge, admin kill switch and configurable envelope byte cap; unchanged old ingest path when disabled.
- [ ] Original chunk retry identity across arbitrary outbox batch boundaries, ordering and conservative run boundaries.
- [ ] Preserve original chunk message_count/session limits; separate physical archive inventories where required.
- [ ] Preserve incremental WebSocket messages and attention/activity/idle cleanup/summary hooks.
- [ ] Expand constituents before materialization watermark/page/cap logic, search and exact read/comment lookup.
- [ ] Additive versioned format, no old-row rewrite; generation triggers and archive hashes support mixed old/new sessions.
- [ ] Real workerd fixture writes regression guard; discriminating duplicate/rebatched replay tests.
- [ ] Exact grouped/search/rendered equivalence; mixed fleet, cap, tool boundary, many batches/pages.
- [ ] Full real coordinator archive round trip, exact read/search/copyback and reset/fence behavior.
- [ ] Relevant lint/typecheck/test/build and migration safety.
- [ ] Local task completion / domain specialist reviews; archive task only after validation.
- [ ] Coordinated staging deploy, real VM and Instant streaming/reload/write measurements; cleanup.
- [ ] PR, CI, CodeRabbit request/wait/findings, trusted-main deploy coordination, merge.
- [ ] Successful production deployment containing commit, two-hour read-only row_usage observation, idea + durable message.

## Acceptance criteria

No content, identity, search, rendering or archive approximation. Kill switch works without deploy. Existing rows remain unchanged and archivable. Measured write reduction is protected by real-runtime tests and staged flows. User-required design and measurement gates must pass before shipping.
