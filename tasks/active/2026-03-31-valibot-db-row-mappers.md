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
- [ ] Create `apps/api/src/durable-objects/project-data/row-schemas.ts`
- [ ] Define `CountRowSchema` for `{ cnt: number }` pattern
- [ ] Define `AcpSessionRowSchema` with all 18 fields
- [ ] Define `ChatMessageRowSchema` for message queries
- [ ] Define `ChatSessionRowSchema` for session listing queries
- [ ] Define `SearchResultRowSchema` for FTS5 search results
- [ ] Define `MaterializationMessageRowSchema` for materialization
- [ ] Define `IdleCleanupScheduleRowSchema` for cleanup rows
- [ ] Define `WorkspaceActivityRowSchema` for activity join queries
- [ ] Define `SessionIdeaLinkRowSchema` and `IdeaSessionDetailRowSchema`
- [ ] Define `CachedCommandRowSchema`
- [ ] Define `ActivityEventRowSchema`
- [ ] Create `apps/api/src/durable-objects/notification-row-schemas.ts`
- [ ] Define `NotificationRowSchema` for notification queries
- [ ] Define `NotificationPreferenceRowSchema`

### Phase 2: Create generic parse helpers
- [ ] Create `parseRow<T>(row: unknown, schema): T` helper that wraps `v.parse` with descriptive error
- [ ] Create `parseRows<T>(rows: unknown[], schema): T[]` helper
- [ ] Create `parseOptionalRow<T>(row: unknown, schema): T | null` for nullable single-row queries

### Phase 3: Create validated mapper functions
- [ ] `parseAcpSessionRow()` → `AcpSession`
- [ ] `parseChatMessageRow()` → `ChatMessage`
- [ ] `parseChatSessionRow()` → `ChatSession` (for listing)
- [ ] `parseNotificationRow()` → `NotificationResponse`
- [ ] `parseNotificationPreferenceRow()` → preference object
- [ ] `parseActivityEventRow()` → `ActivityEvent`
- [ ] `parseIdleCleanupRow()` → cleanup schedule type
- [ ] `parseWorkspaceActivityRow()` → activity type
- [ ] `parseSessionIdeaLinkRow()` → `SessionIdeaLink`
- [ ] `parseCachedCommandRow()` → command type
- [ ] `parseSearchResultRow()` → search result type
- [ ] `parseMaterializationMessageRow()` → materialization type
- [ ] Aggregate parsers: `parseCountRow()`, `parseMaxSeqRow()`, `parseMinRow()`

### Phase 4: Replace casts in each file
- [ ] `acp-sessions.ts` — replace all ~23 casts with mapper calls
- [ ] `messages.ts` — replace all ~33 casts with mapper calls
- [ ] `notification.ts` — replace all ~22 casts with mapper calls
- [ ] `idle-cleanup.ts` — replace all ~18 casts with mapper calls
- [ ] `sessions.ts` — replace all ~12 casts with mapper calls
- [ ] `materialization.ts` — replace all ~11 casts with mapper calls
- [ ] `ideas.ts` — replace all ~9 casts with mapper calls
- [ ] `commands.ts` — replace all ~4 casts with mapper calls
- [ ] `activity.ts` — replace all ~2 casts with mapper calls
- [ ] `index.ts` — replace all ~2 casts with mapper calls
- [ ] `migrations.ts` — replace ~1 cast

### Phase 5: Testing
- [ ] Unit tests for each row schema with valid data
- [ ] Unit tests for each schema with missing required fields (should throw)
- [ ] Unit tests for each schema with wrong types (should throw)
- [ ] Unit tests for NULL handling (nullable fields accept null, required fields reject)
- [ ] Run existing integration tests — all must pass
- [ ] Run `pnpm typecheck` — must pass
- [ ] Run `pnpm lint` — must pass

### Phase 6: Cleanup verification
- [ ] Grep for remaining `as string`, `as number` in DO files — should be zero on row fields
- [ ] Any remaining casts have comments explaining why

## Acceptance Criteria
- [ ] Every SQL query result in DO code is validated through a Valibot schema
- [ ] Zero raw `as string` / `as number` casts on DB row fields (excluding `as const`)
- [ ] Malformed rows throw descriptive errors instead of silently producing wrong values
- [ ] All existing tests pass
- [ ] New unit tests for every mapper function
- [ ] `pnpm typecheck` passes

## References
- `apps/api/src/durable-objects/project-data/` — main DO implementation
- `apps/api/src/durable-objects/notification.ts` — notification DO
- `apps/api/src/schemas/` — existing Valibot patterns
- `packages/shared/src/types.ts` — target interfaces
