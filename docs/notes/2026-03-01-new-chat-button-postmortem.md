# Post-Mortem: Broken "New Chat" Button

**Date**: 2026-03-01
**Severity**: Medium (core UX feature non-functional)
**Duration**: Introduced Feb 25, discovered Feb 28 (3 days)

## What Broke

The "+ New" button in the chat sidebar did nothing. Clicking it briefly navigated to `/projects/:id/chat` (no session ID), but a `useEffect` auto-select immediately detected `sessionId === undefined`, saw existing sessions, and redirected back to the most recent session. The button existed visually but was functionally dead.

## Root Cause

**Commit**: PR #189 (spec 022, Feb 25) — `handleNewChat` and the auto-select `useEffect` were added in the same commit. Both react to `sessionId === undefined`, but with conflicting intent:

```typescript
// Handler: user wants a blank chat
const handleNewChat = () => {
  navigate(`/projects/${projectId}/chat`, { replace: true });
};

// Effect: auto-select fires when sessionId is undefined
useEffect(() => {
  if (!sessionId && sessions.length > 0 && !loading && !provisioning) {
    navigate(`/projects/${projectId}/chat/${sessions[0].id}`, { replace: true });
  }
}, [sessionId, sessions, loading, projectId, navigate, provisioning]);
```

The handler and the effect produce the same observable state (`sessionId === undefined`) but with opposite intent. The effect cannot distinguish "user clicked New Chat" from "initial page load with no session selected."

## Timeline

| When | What |
|------|------|
| Feb 24 (PR #184) | `ProjectChat.tsx` created with auto-select effect. No button yet — effect is benign. |
| Feb 25 (PR #189) | `handleNewChat` and "+ New" button added in same commit as auto-select effect. A `!provisioning` guard was added for task submission, but no guard for new-chat intent. Button ships broken. 529 tests pass. |
| Feb 26-27 (PR #220) | Mobile UX overhaul touches `ProjectChat.tsx`, adds second `onNewChat` handler for mobile drawer. Does not notice or fix the race. |
| Feb 28 | Bug discovered via manual use. Researched and fixed with `useRef` intent flag (commit `53fe488`). |

## Why It Wasn't Caught

### 1. Source-contract tests created false confidence

Six test files use `readFileSync` to read component source as a string and assert substrings exist (`source.toContain(...)`). The chat component tests verified:
- The string `"What do you want to build?"` exists in the source
- The pattern `!sessionId && sessions.length > 0` exists
- The component imports `SessionSidebar`

These tests cannot detect behavioral bugs. They verify code is *present*, not that it *works*. The prompt text was in the source — the test passed — but no user could ever see it after clicking "+ New" because the effect immediately redirected them.

### 2. No behavioral test existed for ProjectChat

The first test file that actually renders `ProjectChat`, simulates clicks, and asserts visible outcomes was created in the fix commit. Before the fix, zero tests rendered this page component.

### 3. Interaction-effect collision was never traced

Spec 022 was a large rewrite (chat-first UX, 7+ phases). `handleNewChat` and the auto-select effect were modified in the same commit but their interaction was never traced. The data flow trace required by `10-e2e-verification.md` was not performed for the "click + New -> navigate -> re-render -> effect fires -> redirect" path.

### 4. PR review didn't catch it

The speckit analysis for 022 flagged "Finding F5: Add New Chat button behavior" — but this only resulted in adding the button. No reviewer traced what would happen when the button's navigation interacted with the existing auto-select effect.

### 5. Same pattern repeated in a later PR

PR #220 (mobile UX overhaul) touched `ProjectChat.tsx` two days later, added a second `onNewChat` path for the mobile drawer, and still didn't notice the race — further evidence that code review alone is insufficient without behavioral tests.

## Class of Bug

**State interaction race condition** — two pieces of code (a handler and an effect) react to the same state with conflicting intent, and there is no mechanism to distinguish the trigger. This class includes:

- Navigation handlers vs. auto-redirect effects
- Form handlers vs. validation/reset effects
- Toggle handlers vs. sync effects
- Any case where user intent and automated behavior produce the same intermediate state

## Fix Applied

Added a `useRef` flag (`newChatIntentRef`) that the handler sets to `true` and the effect checks. When the flag is set, the effect skips auto-selection, allowing the new-chat view to remain visible. The flag is cleared when the user explicitly selects a session.

## Process Fixes (in this PR)

| File | Change |
|------|--------|
| `.claude/rules/02-quality-gates.md` | Added "Prohibited Test Patterns" section banning source-contract tests for interactive components. Added "Interactive Element Test Requirement" requiring behavioral tests for every new button/link/form. Added "Post-Mortem and Process Fix Requirements" making post-mortems and process changes mandatory for bug fix PRs. |
| `.claude/rules/06-technical-patterns.md` | Added "React Interaction-Effect Analysis" rule requiring developers to trace effects that fire after handler state changes. |
| `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md` | Added "Effect Collision Check" to the UI reviewer agent's required checks for interactive changes. |
| `.github/pull_request_template.md` | Added "Post-Mortem" section to the PR template, required for all bug fix PRs. |
| `tasks/backlog/2026-03-01-migrate-source-contract-tests.md` | Created migration task for the 6 existing source-contract test files. |

## Lessons

1. A test that verifies code *exists* is not a test that verifies the code *works*. Interactive components need tests that interact with them.
2. When two pieces of code react to the same state, the interaction must be explicitly traced and tested — it will not be caught by testing each piece in isolation.
3. Large rewrites (speckit batches) that add multiple interacting behaviors in a single commit are high-risk for interaction bugs. Each new handler should be traced against existing effects before commit.
