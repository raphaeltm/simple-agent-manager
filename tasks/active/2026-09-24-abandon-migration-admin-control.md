# Add Abandon Migration Control to Admin → Storage Page

## Problem

Superadmin needs a UI control to abandon poisoned/frozen ProjectData archive migrations from a phone (375px viewport). Currently the only way is calling the admin API route from a browser console. Two production migrations are stuck (`67927ce6` and `6d6f3099`) behind this missing control.

## Research Findings

### Backend (exists on main, do not duplicate)

- `GET /api/admin/project-data/storage/archive-sharding/problem-migrations` → `{ migrations, warnings, limit }` via `listProjectDataArchiveProblemMigrations`. Row shape: `ProjectDataArchiveRolloutMigration` (migrationId, projectId, sessionId, state, errorCode, errorMessage, attemptCount, timestamps including frozenAt/poisonedAt).
- `POST /api/admin/project-data/storage/:projectId/archive-sharding/migrations/:migrationId/abandon` with body `{ reason }` (validated by `ProjectDataArchiveRecoveryControlSchema`). Returns `{ result }` on success. Returns 400 with message for: `abandon_requires_source_intact`, `abandon_requires_expired_lease`, `migration_project_mismatch`, `journal_missing`, `abandon_reason_required`.

### Frontend (exists, follow patterns)

- `AdminStorage.tsx` (317 lines): breaker cards, telemetry rows, close-breaker Dialog with required reason field, TanStack Query, toast, query invalidation.
- `apps/web/src/lib/api/admin-project-data-storage.ts`: API client functions.
- `apps/web/src/lib/query-options/admin-project-data-storage.ts`: query keys and options.
- Tests: `AdminStorage.test.tsx` (unit), `admin-storage-audit.spec.ts` (Playwright).

### Key Patterns to Follow

- TanStack `useQuery`/`useMutation` with `queryClient.invalidateQueries`
- `useToast()` for success/error feedback
- `errorMessage()` helper for extracting error messages
- `Badge` component for state display
- `Dialog` with form, required reason `Input`, Cancel + Submit buttons
- `data-testid` for test targeting
- Stale-while-revalidate (spinner only on first load)

## Implementation Checklist

- [ ] Add shared types to `packages/shared/src/types/admin.ts`:
  - `AdminProjectDataArchiveProblemMigration` interface
  - `AdminProjectDataArchiveProblemMigrationsResponse` interface
  - `AdminProjectDataArchiveMigrationAbandonResponse` interface
- [ ] Add API client functions to `apps/web/src/lib/api/admin-project-data-storage.ts`:
  - `fetchAdminProjectDataArchiveProblemMigrations(limit?)` → GET
  - `abandonAdminProjectDataArchiveMigration(projectId, migrationId, reason)` → POST
- [ ] Add to barrel export `apps/web/src/lib/api/index.ts`
- [ ] Add query key + options to `apps/web/src/lib/query-options/admin-project-data-storage.ts`:
  - `problemMigrations` query key
  - `adminProjectDataArchiveProblemMigrationsQueryOptions`
- [ ] Add to barrel export `apps/web/src/lib/query-options/index.ts`
- [ ] Create `apps/web/src/pages/admin-storage/ProblemMigrations.tsx`:
  - Problem migrations section with heading
  - Per-row card showing: project name, session id, state badge, error code/message, frozen/poisoned timestamps, attempt count
  - "Abandon" button per row opens confirmation Dialog
  - Dialog: required reason input, server refusal messages shown verbatim in Alert
  - Toast on success, refetch on success
  - Empty state when no problem migrations
  - Truncation disclosure if limit was hit (rule 65)
  - One-line note: closing a breaker does not thaw frozen migrations; abandon is for pre-source-deletion migrations
- [ ] Update `AdminStorage.tsx` to import and render `ProblemMigrations` section
- [ ] Unit tests in `apps/web/tests/unit/AdminStorage.test.tsx`:
  - Render problem migrations with realistic multi-project fixtures
  - Open dialog, submit with reason, assert exact URL and body
  - Assert 400 refusal message shown to user
  - Assert list refetches on success
- [ ] Playwright visual audit in `apps/web/tests/playwright/admin-storage-audit.spec.ts`:
  - Problem migrations with normal data at 375px and 1280px
  - Long error messages, many rows
  - Empty state
  - Abandon dialog open state

## Acceptance Criteria

- [ ] Problem migrations section visible on Admin → Storage page
- [ ] Each problem migration shows project, session, state, error info, timestamps, attempt count
- [ ] Abandon button opens confirmation dialog with required reason field
- [ ] Successful abandon shows toast, refetches list
- [ ] Server 400 refusals show verbatim message in dialog
- [ ] Empty state message when no problem migrations
- [ ] Truncation disclosed if list was capped
- [ ] Explanation line about breakers vs abandon
- [ ] AdminStorage.tsx stays under 500 lines (rule 18)
- [ ] Usable at 375px viewport
- [ ] No horizontal overflow
- [ ] Passes lint, typecheck, tests, build

## References

- `apps/api/src/routes/admin/project-data-storage.ts` (backend routes)
- `apps/web/src/pages/AdminStorage.tsx` (existing page)
- `apps/web/src/lib/api/admin-project-data-storage.ts` (API client)
- Tracking idea: `01M35R2B08V0BBDK80TPC4PC5P`
