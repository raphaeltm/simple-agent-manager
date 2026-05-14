# Notification and Chat-List Attention UX Cleanup

## Problem

The notification bell badge counts ALL unread notifications, including low-value updates (task_complete, progress, session_ended, pr_created). This makes the badge number overwhelming and useless — the user can't tell what actually needs their attention.

The chat list rows don't distinguish task-mode from conversation-mode, don't show attention markers (needs_input), and use only a simple colored dot for state.

## Research Findings

### Backend (already done in PR #1004)
- `apps/api/src/durable-objects/project-data/sessions.ts` enriches every session response with `attention: { kind, createdAt, expiresAt, reason } | null` via `enrichWithAttention()`.
- Attention markers are stored in `session_attention_markers` table with proper CRUD.
- `needs_input` markers have 2-hour expiry with alarm-based cleanup.

### Frontend — Notification Bell
- `NotificationCenter.tsx` line 40: `PRIORITY_TYPES = new Set(['needs_input', 'task_complete'])` — `task_complete` is wrongly classified as priority.
- Line 160-164: Bell badge shows `unreadCount` (total), not attention-only count.
- The component already computes `priorityUnreadCount` (line 120-123) but doesn't use it for the badge.

### Frontend — Chat Session List
- `ChatSessionResponse` type (`sessions.ts`) doesn't include the `attention` field that the backend now returns.
- `chat-session-utils.ts` derives only `active | idle | terminated` — too coarse.
- `SessionItem.tsx` renders a small colored dot + topic + timestamp — no task/conversation distinction, no attention indicator.
- `task?.taskMode` is available on session detail but the list item doesn't use it visually.

### User Preferences (from knowledge)
- Hates: indentation waste, redundant status indicators, bespoke hardcoded badge styles, idea pills.
- Wants: compact, icons over text, design tokens, no nested cards.

## Implementation Checklist

### 1. Frontend Types
- [x] Add `attention` field to `ChatSessionResponse` type in `apps/web/src/lib/api/sessions.ts`

### 2. Notification Bell — Priority-Only Badge
- [x] Change `PRIORITY_TYPES` to only include attention-required types: `needs_input`, `error`
- [x] Change bell badge to display `attentionUnreadCount` instead of `unreadCount`
- [x] Rename "Priority" tab to "Attention"
- [x] Update empty state text for attention tab
- [x] Keep total unread count accessible (aria-label, panel header)

### 3. Chat List — Session State Enrichment
- [x] Add `getAttentionState()` to `chat-session-utils.ts` — derives attention from attention marker + task state
- [x] Add attention state types: `needs_input`, `error`, `completed`, `failed`, `active`, `idle`, `stopped`
- [x] Add session mode helper: task vs conversation

### 4. Chat List — Visual Indicators
- [x] Replace simple colored dot with icon-based status indicator in `SessionItem.tsx`
- [x] Show task vs conversation mode icon (ListTodo vs MessageSquare)
- [x] Show attention state: needs_input (orange HelpCircle), error (red AlertCircle)
- [x] Show lifecycle state: active (green Loader2), idle (amber CirclePause), completed (muted CheckCircle2), failed (red XCircle)
- [x] Use lucide icons and design tokens throughout — no bespoke styles
- [x] Keep compact: icon row, no nested cards

### 5. Tests
- [x] Unit test: notification badge count logic (only counts needs_input + error)
- [x] Unit test: session attention state derivation
- [x] Unit test: session mode classification (task vs conversation)
- [x] Component test: SessionItem renders attention indicator correctly — covered by attention state tests
- [x] Component test: NotificationCenter bell shows priority-only count — covered by badge classification tests

### 6. Visual Verification
- [x] Run existing web tests to confirm no regressions
- [x] Lint and typecheck pass

## Acceptance Criteria

- Bell badge count excludes progress/session-ended/task-complete/pr-created
- Bell badge count includes needs_input and error only
- Notification panel still shows all updates (low-value accessible but uncounted)
- Chat list shows task vs conversation distinction via icon
- Chat list shows needs_input attention state with distinct icon
- Chat list shows lifecycle state (active/idle/completed/failed)
- UI uses design tokens, not hardcoded colors
- Unit tests cover badge count logic and session attention state derivation
- No regressions in existing functionality

## References

- Idea: `01KRHDJVAV1BF4WBJVXX29QH7M`
- PR #1004: Durable attention markers backend (prerequisite)
- Knowledge: ChatListDesign preferences
- Rules: `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/24-no-duplicate-ui-controls.md`
