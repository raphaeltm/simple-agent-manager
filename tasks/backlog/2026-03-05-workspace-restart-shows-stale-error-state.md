# Workspace Restart Shows Stale Error State

## Problem

When restarting a workspace that previously failed (devcontainer build error), the workspace detail page shows both the old failure state AND the new provisioning attempt simultaneously. Specifically:

1. Header shows status "Creating" (correct — new attempt in progress)
2. Main area shows "Provisioning Failed" heading with old error text
3. Step indicators show mixed state: check volume ready, spinner on "Cloning repository", X "Devcontainer build failed"
4. The old multi-hundred-line error log remains visible

After 30+ seconds, the state hadn't resolved — still showing the stale error with the "Cloning repository" spinner.

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Medium — confusing UX, users can't tell if restart is working
- **Page**: Workspace detail page (`/workspaces/:id`)

## Research Findings

### Root Cause Chain

Three separate issues combine to create the stale state:

1. **KV boot logs not cleared on restart** (`apps/api/src/routes/workspaces.ts:719-769`): The restart route clears `errorMessage` in D1 but does NOT clear boot logs from KV (`bootlog:<workspaceId>`). Old failed step entries persist and new ones are appended on top. The `BootProgress` component deduplicates by step name (last-write-wins), but steps from the previous failure that haven't re-run yet will still show their old failed state.

2. **React state not fully cleared optimistically** (`apps/web/src/pages/Workspace.tsx:609-620`): `handleRestart()` sets `status: 'creating'` but does NOT clear `errorMessage` or `bootLogs` from the workspace state. There's a ~5s polling gap where stale data can leak through.

3. **Same issue exists in `handleRebuild()`** (`Workspace.tsx:622-637`): Neither `errorMessage` nor `bootLogs` are cleared.

### Key Files

| File | Role |
|------|------|
| `apps/api/src/routes/workspaces.ts:719-769` | Restart route — needs to clear KV boot logs |
| `apps/api/src/routes/workspaces.ts:771-813` | Rebuild route — same issue |
| `apps/api/src/services/boot-log.ts:45-56` | `writeBootLogs()` — can clear logs with empty array |
| `apps/web/src/pages/Workspace.tsx:609-620` | `handleRestart()` — needs to clear errorMessage + bootLogs |
| `apps/web/src/pages/Workspace.tsx:622-637` | `handleRebuild()` — same fix needed |
| `apps/web/src/hooks/useBootLogStream.ts` | Already clears streamed logs when status leaves 'creating' |

### Fix Approach

**API side**: Clear KV boot logs in both restart and rebuild routes before starting provisioning.

**UI side**: Clear `errorMessage` and `bootLogs` optimistically in `handleRestart()` and `handleRebuild()`.

## Implementation Checklist

- [ ] Add `writeBootLogs(c.env.BOOT_LOG_KV, workspaceId, [])` to restart route before `waitUntil`
- [ ] Add `writeBootLogs(c.env.BOOT_LOG_KV, workspaceId, [])` to rebuild route before `waitUntil`
- [ ] Clear `errorMessage: null, bootLogs: []` in `handleRestart()` optimistic state update
- [ ] Clear `errorMessage: null, bootLogs: []` in `handleRebuild()` optimistic state update
- [ ] Add unit test: restart route clears boot logs from KV
- [ ] Add unit test: rebuild route clears boot logs from KV
- [ ] Add UI test: handleRestart clears error state optimistically

## Acceptance Criteria

- [ ] Workspace restart clears previous error state from the UI
- [ ] Fresh provisioning progress is shown for the new attempt
- [ ] Previous failure is not mixed with current provisioning status
- [ ] Boot logs in KV are cleared before new provisioning begins
- [ ] Same fix applies to rebuild flow
