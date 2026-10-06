# Report an Issue → SAM Idea Flow (Phase 0 Loop A)

## Problem

Users have no in-app way to report issues. When something goes wrong (error, failed session, broken node), they must leave the app to file feedback. This feature adds a hosted "Report an Issue" flow that creates a draft Idea in a configurable feedback project, with explicit consent for attaching bounded technical references.

## Research Findings

### Existing Idea Creation Patterns
- Ideas are tasks with `status: 'draft'` in the D1 `tasks` table — no separate table
- REST: `POST /api/projects/:projectId/tasks` with `CreateTaskSchema` validation
- MCP: `create_idea` handler in `idea-tools.ts` uses `sanitizeUserInput()` from `_helpers.ts`
- Admin: `saveDebugDiagnosisAsIdea` in `debug-agent.ts` creates from diagnosis with project picker
- Shared types: `Task`, `CreateTaskRequest` in `packages/shared/src/types/task.ts`

### Environment Variable Contract
- `PLATFORM_FEEDBACK_PROJECT_ID` does NOT exist yet — sibling backend triage task hasn't merged
- Must be added to `apps/api/src/env.ts` Env interface and shared constants
- Must be configurable (Constitution Principle XI) with no hardcoded SAM project ID
- Pattern: optional `string?` in Env, with `DEFAULT_*` constant in shared

### Content Safety / Sanitization
- `sanitizeUserInput()` in `apps/api/src/routes/mcp/_helpers.ts` strips null bytes, bidi overrides, control chars
- Idea content max: 65,536 chars (MCP) / 5,000 chars (admin diagnosis path)
- User text must be fenced/labeled as untrusted with clear provenance markers

### UI Entry Points (Non-Cluttering)
- **SessionHeader action row** (expanded) — natural for session-context reports; already has Files, Git, Workspace, Timeline, Complete buttons with flex-wrap
- **ErrorBoundary crash screen** — users hitting errors have highest intent to report
- Both surfaces provide context refs (sessionId, taskId, nodeId) without broad nav clutter

### UI Components Available
- `Dialog` from `@simple-agent-manager/ui` — portal-based modal with backdrop, escape-to-close
- `Button`, `Input`, `Card`, `Alert`, `Spinner`, `Toast` from shared UI
- Form dialog pattern established in `SkillFormDialog.tsx`
- `ConfirmDialog` pattern for consent checkboxes

### Authorization Pattern
- Session auth: `requireAuth()` + `requireApproved()` + `requireProjectCapability()`
- Cross-tenant validation: verify user can access referenced session/task/node before storing ref
- Query D1 to verify ownership: `tasks.created_by = userId` or project membership

## Implementation Checklist

### Backend (API)

- [x] Add `PLATFORM_FEEDBACK_PROJECT_ID` to `apps/api/src/env.ts` Env interface
- [x] Add `DEFAULT_REPORT_TITLE_MAX_LENGTH` and `DEFAULT_REPORT_DESCRIPTION_MAX_LENGTH` constants to `packages/shared/src/constants/`
- [x] Create report validation schema in `apps/api/src/schemas/report.ts` — title, description, consentToAttachRefs, optional refs (sessionId, taskId, nodeId, errorId, diagnosisId)
- [x] Create report service in `apps/api/src/services/report-issue.ts`:
  - Validate user owns/can-access each referenced resource (cross-tenant check)
  - Sanitize user text with `sanitizeUserInput()`, fence untrusted content with provenance markers
  - Redact potential secrets/PII from description
  - Create draft idea in the feedback project with structured content
  - Return created idea ID and what was attached
- [x] Create API route `POST /api/report-issue` in `apps/api/src/routes/report-issue.ts`:
  - Auth: `requireAuth()`, `requireApproved()`
  - Check `env.PLATFORM_FEEDBACK_PROJECT_ID` is set; return 404/disabled if not
  - Validate body, call service, return result
- [x] Add `GET /api/report-issue/config` route that returns `{ enabled: boolean }` for the UI to conditionally show/hide the feature
- [x] Mount routes in `apps/api/src/index.ts`

### Frontend (Web)

- [x] Add API client functions in `apps/web/src/lib/api/report.ts`: `getReportConfig()`, `submitReport()`
- [x] Create `ReportIssueDialog` component in `apps/web/src/components/ReportIssueDialog.tsx`:
  - Title input (required)
  - Description textarea (required)
  - Consent checkbox for attaching technical refs
  - Display which refs will be attached (sessionId, taskId, etc.) when consent is checked
  - Submit button with loading state
  - Success state showing idea ID and what was/wasn't attached
  - Error state with retry
- [x] Add "Report Issue" button to `SessionHeader.tsx` action row (expanded view):
  - Small ghost button with Flag icon
  - Opens ReportIssueDialog with session context (sessionId, taskId, nodeId)
  - Only visible when report config says enabled
- [x] Add "Report this issue" link to `ErrorBoundary.tsx`:
  - Small text link under the error message
  - Opens ReportIssueDialog with error context
  - Only visible when report config says enabled
- [x] Ensure dialog works correctly on mobile (375px) and desktop (1280px)

### Shared Types

- [x] Add `ReportIssueRequest` and `ReportIssueResponse` types to `packages/shared/src/types/`
- [x] Add `ReportConfig` type for the config endpoint response
- [x] Export from shared package index

### Tests

- [x] API integration test: successful report creation with refs
- [x] API integration test: report without refs (no consent)
- [x] API integration test: disabled when PLATFORM_FEEDBACK_PROJECT_ID unset — returns 404/disabled
- [x] API integration test: unauthorized ref rejection (cross-tenant) — discriminating test where user A tries to reference user B's session
- [x] API integration test: content sanitization and provenance marking
- [x] API integration test: title/description length validation
- [x] UI behavioral test: dialog opens, form submits, success state shown
- [x] UI behavioral test: consent checkbox controls ref attachment
- [x] UI behavioral test: dialog hidden when feature disabled

### Documentation

- [x] Add `PLATFORM_FEEDBACK_PROJECT_ID` to `apps/api/.env.example`
- [x] Update CLAUDE.md Recent Changes section

## Acceptance Criteria

1. A user can report an issue from the chat session header or error boundary
2. The report creates a draft Idea in the configured feedback project
3. If `PLATFORM_FEEDBACK_PROJECT_ID` is unset, the feature is hidden/disabled
4. Technical refs are only attached with explicit user consent via checkbox
5. Server validates user authorization for each referenced resource
6. Cross-tenant ref access is rejected with a discriminating test
7. User text is sanitized and fenced with provenance markers
8. After submission, user sees the draft Idea ID and what was attached
9. All tests pass: validation, consent, unauthorized refs, disabled state, redaction
10. No hardcoded project IDs (Constitution Principle XI)
11. Mobile and desktop Playwright visual audit passes with no overflow

## References

- Canonical idea: `01KXN5YQ9TGN29ZZ8DP2DKAKHN`
- PR #1688: standalone debug agent on /admin/errors
- `.claude/rules/03-constitution.md`: No hardcoded values
- `.claude/rules/51-server-side-node-class-gates.md`: Server-side authorization
- `.claude/rules/11-fail-fast-patterns.md`: Identity validation at boundaries
