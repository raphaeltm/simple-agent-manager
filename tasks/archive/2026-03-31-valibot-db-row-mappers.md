# Valibot DB Row Mappers for Durable Objects

## Problem

Durable Object code queries SQLite and uses ~157 raw `as string` / `as number` type casts on row fields. If a column is NULL, renamed, or has a different type than expected, the cast silently produces a wrong value. Replace these with Valibot-validated mapper functions that throw descriptive errors on malformed data.

## Research Findings

### Files with `as` casts on DB row fields

| File | Cast Count | Row Shapes |
|------|-----------|------------|
| `apps/api/src/durable-objects/project-data/messages.ts` | 33 | Message row, search result, count, max_seq |
| `apps/api/src/durable-objects/project-data/acp-sessions.ts` | 23 | Full AcpSession row, count, partial selects |
| `apps/api/src/durable-objects/notification.ts` | 22 | Notification row, preference row, count, enabled checks |
| `apps/api/src/durable-objects/project-data/idle-cleanup.ts` | 18 | Cleanup schedule, workspace activity, min aggregates |
| `apps/api/src/durable-objects/project-data/sessions.ts` | 12 | Chat session listing, count, partial selects |
| `apps/api/src/durable-objects/project-data/materialization.ts` | 11 | Session status, message rows, rowid, count |
| `apps/api/src/durable-objects/project-data/ideas.ts` | 9 | Session-idea links, session details |
| `apps/api/src/durable-objects/project-data/commands.ts` | 4 | Cached command row |
| `apps/api/src/durable-objects/project-data/activity.ts` | 2 | Activity event row (payload JSON parse) |
| `apps/api/src/durable-objects/project-data/index.ts` | 2 | Count, latest timestamp |
| `apps/api/src/durable-objects/migrations.ts` | 1 | Migration version |
| `apps/api/src/durable-objects/notification-migrations.ts` | 1 | Migration name |

### Existing patterns

- Valibot v1.3.1 already installed (PR #582)
- Schemas defined in `apps/api/src/schemas/` using `v.object()`, `v.string()`, `v.number()`, `v.picklist()`, `v.nullable()`, `v.optional()`
- Existing mapper functions (e.g., `mapAcpSessionRow()`) already do the snake_case→camelCase translation, just with `as` casts
- Shared types in `packages/shared/src/types.ts` define the target interfaces

### Key row shapes to schema-fy

1. **AcpSessionRow** — 18 fields, maps to `AcpSession` interface
2. **ChatMessageRow** — 7 fields, maps to `ChatMessage` interface
3. **ChatSessionRow** — 11+ fields, maps to `ChatSession` interface
4. **NotificationRow** — 12 fields, maps to `NotificationResponse` interface
5. **NotificationPreferenceRow** — 4 fields
6. **ActivityEventRow** — 9 fields, maps to `ActivityEvent` interface
7. **IdleCleanupRow** — 4 fields (cleanup schedule)
8. **WorkspaceActivityRow** — 5 fields
9. **SessionIdeaLinkRow** — 3+ fields
10. **CachedCommandRow** — 4 fields
11. **Aggregate rows** — CountRow (`cnt`), MaxRow (`max_seq`), MinRow (`earliest`)
12. **SearchResultRow** — extends message with session metadata
13. **MaterializationRow** — message subset for grouping

## Implementation Checklist

### Phase 1: Create schema file with all row schemas
- [x] Create `apps/api/src/durable-objects/project-data/row-schemas.ts`
- [x] Define `CountRowSchema` for `{ cnt: number }` pattern
- [x] Define `AcpSessionRowSchema` with all 18 fields
- [x] Define `ChatMessageRowSchema` for message queries
- [x] Define `ChatSessionRowSchema` for session listing queries
- [x] Define `SearchResultRowSchema` for FTS5 search results
- [x] Define `MaterializationMessageRowSchema` for materialization
- [x] Define `IdleCleanupScheduleRowSchema` for cleanup rows
- [x] Define `WorkspaceActivityRowSchema` for activity join queries
- [x] Define `SessionIdeaLinkRowSchema` and `IdeaSessionDetailRowSchema`
- [x] Define `CachedCommandRowSchema`
- [x] Define `ActivityEventRowSchema`
- [x] Create `apps/api/src/durable-objects/notification-row-schemas.ts`
- [x] Define `NotificationRowSchema` for notification queries
- [x] Define `NotificationPreferenceRowSchema`

### Phase 2: Create generic parse helpers
- [x] Create `parseRow<T>(row: unknown, schema): T` helper that wraps `v.safeParse` with descriptive error
- [x] ~~Create `parseOptionalRow<T>(row: unknown, schema): T | null` for nullable single-row queries~~ — Not needed: callers use `if (!row) return` guard then pass to `parseRow`, which is simpler and equally safe

### Phase 3: Create validated mapper functions
- [x] `parseAcpSessionRow()` → `AcpSession`
- [x] `parseChatMessageRow()` → `ChatMessage`
- [x] `parseChatSessionRow()` → `ChatSession` (for listing)
- [x] `parseNotificationRow()` → `NotificationResponse`
- [x] `parseNotificationPreferenceRow()` → preference object
- [x] `parseActivityEventRow()` → `ActivityEvent`
- [x] `parseIdleCleanupRow()` → cleanup schedule type
- [x] `parseWorkspaceActivityRow()` → activity type
- [x] `parseSessionIdeaLinkRow()` → `SessionIdeaLink`
- [x] `parseCachedCommandRow()` → command type
- [x] `parseSearchResultRow()` → search result type
- [x] `parseMaterializationMessageRow()` → materialization type
- [x] Aggregate parsers: `parseCountRow()`, `parseMaxSeqRow()`, `parseMinRow()`

### Phase 4: Replace casts in each file
- [x] `acp-sessions.ts` — replace all ~23 casts with mapper calls
- [x] `messages.ts` — replace all ~33 casts with mapper calls
- [x] `notification.ts` — replace all ~22 casts with mapper calls
- [x] `idle-cleanup.ts` — replace all ~18 casts with mapper calls
- [x] `sessions.ts` — replace all ~12 casts with mapper calls
- [x] `materialization.ts` — replace all ~11 casts with mapper calls
- [x] `ideas.ts` — replace all ~9 casts with mapper calls
- [x] `commands.ts` — replace all ~4 casts with mapper calls
- [x] `activity.ts` — replace all ~2 casts with mapper calls
- [x] `index.ts` — replace all ~2 casts with mapper calls
- [x] `migrations.ts` — replace ~1 cast
- [x] `notification-migrations.ts` — replace ~1 cast

### Phase 5: Testing
- [x] Unit tests for each row schema with valid data (77 tests)
- [x] Unit tests for each schema with missing required fields (should throw)
- [x] Unit tests for each schema with wrong types (should throw)
- [x] Unit tests for NULL handling (nullable fields accept null, required fields reject)
- [x] Run existing integration tests — all 2851 API tests pass
- [x] Run `pnpm typecheck` — passes
- [x] Run `pnpm lint` — passes (warnings only, no errors)

### Phase 6: Cleanup verification
- [x] Grep for remaining `as string`, `as number` in DO files — zero on row fields
- [x] Two `as NotificationType`/`as NotificationUrgency` casts remain in notification-row-schemas.ts — these narrow Valibot picklist output to shared type aliases (type-level only, data already validated)

## Acceptance Criteria
- [x] Every SQL query result in DO code is validated through a Valibot schema
- [x] Zero raw `as string` / `as number` casts on DB row fields (excluding `as const`)
- [x] Malformed rows throw descriptive errors instead of silently producing wrong values
- [x] All existing tests pass
- [x] New unit tests for every mapper function
- [x] `pnpm typecheck` passes

## References
- `apps/api/src/durable-objects/project-data/` — main DO implementation
- `apps/api/src/durable-objects/notification.ts` — notification DO
- `apps/api/src/schemas/` — existing Valibot patterns
- `packages/shared/src/types.ts` — target interfaces
