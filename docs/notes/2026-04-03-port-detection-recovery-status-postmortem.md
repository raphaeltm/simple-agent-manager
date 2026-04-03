# Post-Mortem: Port Detection Disabled in Recovery Status

## What Broke

When a workspace enters `recovery` status (devcontainer build failed, fallback container used), the project chat UI silently disables port detection polling. Detected ports never appear in the session header, so users cannot discover or click port-forwarded URLs. The underlying port forwarding proxy works correctly — navigating directly to `ws-{id}--{port}.{domain}` loads the content. The bug is purely in the UI's port visibility.

## Root Cause

`useSessionLifecycle.ts:231` derived `isWorkspaceRunning` by checking only `workspace?.status === 'running'`. Workspaces in `recovery` status were excluded, disabling both `useTokenRefresh` and `useWorkspacePorts`.

The workspace page (`useWorkspaceCore.ts:72`) already handled this correctly with `status === 'running' || status === 'recovery'`. The project chat view (the primary UX surface per spec 022) had a stricter, incorrect check.

## Timeline

- **Unknown date**: The `recovery` status was introduced for devcontainer fallback scenarios.
- **PR #575 (2026-03-27)**: Added `useTokenRefresh` to fix token expiry for port display — but the token refresh was gated by the same `isWorkspaceRunning` check, inheriting the bug.
- **2026-04-03**: User reports port forwarding "broken" after testing with an Astro dev server. Investigation reveals workspace was in `recovery` status; ports invisible in chat but proxy works directly.

## Why It Wasn't Caught

1. **No test for recovery + port interaction**: Port detection tests (`useWorkspacePorts.test.ts`) test the hook in isolation with a boolean `isRunning` parameter. No test verified that the calling code computes `isRunning` correctly for all workspace statuses.
2. **The workspace page already had the fix**: `useWorkspaceCore.ts` includes `recovery`, so testing from the workspace view would not reproduce the bug.
3. **Project chat is the primary surface**: Per rule 26 (Project Chat First), the project chat is where most users interact. But the workspace page — a secondary surface — had the correct behavior, creating a false sense of "it works."

## Class of Bug

**Inconsistent status derivation across code paths.** When multiple components independently derive a boolean from an enum status, they drift. One gets updated for a new status value; the others don't.

## Process Fix

1. **Added regression test** (`workspace-running-status.test.ts`) that explicitly tests `recovery` status is treated as running.
2. **Rule consideration**: When a status enum gains a new value, all derivation sites must be audited. This is a manual process; a future improvement could extract a shared `isWorkspaceOperational(status)` utility.
