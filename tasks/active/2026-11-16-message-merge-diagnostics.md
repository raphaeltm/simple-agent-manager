# Explain production message-merging write rates

The first 30 minutes of production ON coverage showed 27.38 writes/call versus24.65 OFF. Current row_usage telemetry cannot distinguish merger precondition failures from a low assistant-text share. A stale project WebSocket can disable merging for all sessions.

Authorized by parent task01M7CVZNSP0EHV9BJ72HCFQJSC eventc25c632b-edbd-4c95-8d3d-8b59bad3c098 as a counter-only followup to PR2760.

Research: ProjectData.index persistMessageBatch combines admin setting with relevant socket capabilities; MessageStreamBatch evaluates source/sequence/receipt/open-row boundaries; messages.persistMessageBatch applies transaction writes; RowUsage aggregates in memory and flushes existing log windows. ACP thinking/tool rows are excluded from assistant merging. Existing reporter fixture has no thinking.

- [ ] Add bounded content-free counters to existing row_usage windows: received/accepted/inserted by fixed role, eligible accepted chunks, coalesced chunks, append SQL statements, refused batches and run breaks by fixed enums.
- [ ] Sample legacy session/project socket counts as window maxima. Preserve all storage, wire and configuration behavior, add no SQL writes or schema.
- [ ] Record committed synchronous persistence outcomes even if later side effects fail; no outcomes from rollback.
- [ ] Real-workerd tests drive persistence, retries, refusal gates, legacy sockets, role mix, same-batch and cross-batch merges, flush/reset and no extra SQL writes; negative-control discrimination.
- [ ] Relevant build/lint/typecheck/tests and required quality checks; local domain/completion review, CodeRabbit best effort.
- [ ] Coordinate per-installation staging lease, deploy, real Claude thinking/tool-heavy ON/OFF comparison and legacy socket gate; record counts/hash only and clean all owned resources/auth/settings.
- [ ] PR green, merge, first successful production deploy containing commit; read-only counters report and H1/H2 conclusion if supported.

Acceptance: fixed-cardinality logs explain effective gates and physical outcomes without content/IDs or new storage writes. ON/OFF transcript/storage behavior stays identical to approved PR2760. Representative live run reports role mix, eligibility, append/insert counts and writes/call. Explain stale-client mitigation and thinking/tool followups without changing them in this PR.
