# ProjectData list row isolation hardening

## Problem

ProjectData Durable Object list reads must not fail an entire API/list response when one stored row is malformed or no longer matches the current row schema. The sessions list path already has row-level isolation, but message list reads still map fetched rows through throwing parsers. A malformed `chat_messages` row can therefore break message list retrieval for otherwise valid session history.

Also fix the stale bootstrap TTL comment/test wording so it remains correct when the TTL is configurable.

## Research findings

- `.claude/rules/50-list-read-row-fault-isolation.md` requires per-row parse/enrichment isolation for multi-row D1/DO SQLite reads.
- `apps/api/src/durable-objects/project-data/sessions.ts` already uses `enrichSessionRows()` to skip and warn-log malformed session rows without changing the response contract.
- `apps/api/src/durable-objects/project-data/messages.ts:getMessages()` still does `orderedRows.map(parseChatMessageRow...)`, so one malformed row throws the whole read.
- `apps/api/tests/unit/durable-objects/project-data-messages.test.ts` has focused unit coverage for `getMessages()` ordering and pagination.
- `apps/api/src/services/bootstrap.ts` and `apps/api/tests/unit/services/bootstrap.test.ts` describe the default TTL as 15 minutes/900 seconds, but comments should not imply a fixed TTL when `BOOTSTRAP_TOKEN_TTL_SECONDS` overrides it.

## Checklist

- [x] Add row-level parse isolation to `getMessages()` for normal and compact message rows.
- [x] Warn-log skipped message rows with context, best-effort row id/session id, compact mode, and parser error.
- [x] Preserve the existing `{ messages, hasMore }` response contract and ordering behavior.
- [x] Add a good/bad/good regression test for malformed message rows.
- [x] Add an all-bad regression test returning an empty non-throwing list.
- [x] Update stale bootstrap TTL comment/test wording without changing runtime behavior.
- [x] Run targeted tests and broader validation.
- [x] Run local reviewer/subagent checks for tests and code review.
- [x] Open PR, wait for CI, and do not merge.

## Acceptance criteria

- Message list reads skip malformed rows and return valid rows instead of throwing.
- Skip behavior is diagnosable via structured warn logging.
- Existing API/response shape is unchanged.
- Targeted tests cover malformed rows among valid rows and the all-bad case.
- Bootstrap TTL comment/test wording reflects configurability.
- PR is open with CI green and remains unmerged.
