# Keep chat session lists ordered by real conversation activity

## Problem

Old project chats can jump to the top of the session list when lifecycle or retention work updates the session's `updated_at`, even though no new conversation activity occurred. This makes stale tasks and sessions look current and can affect which sessions users see first.

## Research findings

- Earlier research tasks `01M2W7SE12S74DPHT1E5VW8SSJ` and `01M2X10Y8QSJSXP7SDZ4JCCJEP` identified snapshot-expiry terminalization as a source of synthetic `updated_at` bumps. Both tasks failed without creating a PR; neither fix shipped.
- Production D1, queried 2026-10-04: among sessions updated in the prior 14 days, there were 200 stopped sessions; 159 have `updated_at` more than two days later than `last_message_at`, and 154 are within one hour of a seven-day gap. This is consistent with snapshot TTL terminalization.
- `session_summaries` already has `last_message_at`, populated from compact archive and/or live message timestamps. The per-project D1 index sorted by `updated_at DESC` and mapped `lastMessageAt` from `updated_at`.
- The authoritative ProjectData list was also sorted/mapped using `updated_at`; the response may come from the D1 accelerator or fall back to this DO path. Cross-project recent lists likewise used lifecycle `updated_at` for rank and stale filtering.
- `session.activity` describes agent lifecycle, not transcript creation. In particular, `promptStartedAt` may be synthesized or delivered after persistence, so it cannot safely advance client message recency. Sessions with no messages need a stable creation/start timestamp fallback.
- The project sidebar receives canonical message events only on the selected-session socket; project-level summary reconciliation runs every 10 minutes while connected. The server list/refetch is correct immediately, while live sidebar freshness is tracked as a separate follow-up idea (`01M43Q6081PF9P118E88RPGKXG`).
- Historical D1 `last_message_at` values already provide the real activity timestamp. Prefer changing read semantics over rewriting existing rows.

## Implementation checklist

- [x] Trace project and cross-project list query paths, mapping, sort keys and pagination; keep the indexed D1 path and DO fallback equivalent.
- [x] Use the newest real conversation message timestamp as the primary rank, with a stable creation/start fallback for empty sessions and deterministic `id DESC` tie-breaking.
- [x] Keep persisted message activity authoritative across D1 sync and API refetch; do not promote lifecycle-only WebSocket events into a fabricated message timestamp.
- [x] Add regressions for lifecycle timestamp bumps, max(archive, live-message) sync, empty sessions, stable pagination, genuine new activity and browser archive ordering.
- [x] Run focused API/web tests, query-plan checks, migration-safety checks, typechecks, independent review, and the desktop/mobile Playwright audit.
- [x] Deploy to unoccupied staging and verify the session list behavior end-to-end.
- [ ] Resolve remaining CI jobs, merge through the requested output branch, and verify the production deploy.

## Verification status

- Staging deployment succeeded: workflow [37212942078](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37212942078). Staging D1 applied migration 0181 and the project activity query uses `idx_session_summaries_project_activity`.
- Authenticated Playwright against `app.sammy.party` verified the project sessions API order by genuine activity, confirmed a stopped session with a recent lifecycle `updated_at` appeared after a newer conversation, and confirmed it was visible inside the expanded `Older` sidebar group. Project, session, and supporting APIs returned 200 with no page errors.
- PR #2228 is open at https://github.com/raphaeltm/simple-agent-manager/pull/2228. Current CI run 37213744834 has its Test and Durable Object Workers jobs pending; all other checks passed. SonarCloud passed at 2.9% duplication. CodeRabbit was rate-limited after one trusted request and 15-minute wait; no review findings arrived.
- This record is archived while the PR/production gates remain open; archival does not mark the SAM task complete.

## Acceptance criteria

- Stopping or expiring an old sleeping session does not move it ahead of a session with more recent actual conversation activity.
- A newly persisted user/assistant conversation message becomes the activity timestamp used by the list API; a list refresh orders it first. The connected sidebar currently receives list-summary updates on its bounded 10-minute reconciliation cadence.
- D1-index and ProjectData fallback results return the same ordering and do not skip/repeat sessions across pages.
- Empty sessions keep a stable order based on creation/start time.
- No data rewrite is needed to correct existing stale rows.

## References

- `apps/api/src/services/session-summary-index.ts`
- `apps/api/src/durable-objects/project-data/session-summary-sync.ts`
- `apps/api/src/durable-objects/project-data/sessions.ts`
- `apps/web/src/pages/project-chat/useProjectChatState.ts`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/25-review-merge-gate.md`
