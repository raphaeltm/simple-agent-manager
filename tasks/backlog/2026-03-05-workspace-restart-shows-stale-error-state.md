# Workspace Restart Shows Stale Error State

## Problem

When restarting a workspace that previously failed (devcontainer build error), the workspace detail page shows both the old failure state AND the new provisioning attempt simultaneously. Specifically:

1. Header shows status "Creating" (correct — new attempt in progress)
2. Main area shows "Provisioning Failed" heading with old error text
3. Step indicators show mixed state: ✓ volume ready, spinner on "Cloning repository", ✗ "Devcontainer build failed"
4. The old multi-hundred-line error log remains visible

After 30+ seconds, the state hadn't resolved — still showing the stale error with the "Cloning repository" spinner.

## Expected Behavior

When a workspace is restarted:
1. Clear the previous error state entirely
2. Show a fresh provisioning progress view
3. Display new step-by-step progress from the new attempt
4. Only show errors from the current attempt if it fails again

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Medium — confusing UX, users can't tell if restart is working
- **Page**: Workspace detail page (`/workspaces/:id`)

## Acceptance Criteria

- [ ] Workspace restart clears previous error state from the UI
- [ ] Fresh provisioning progress is shown for the new attempt
- [ ] Previous failure is not mixed with current provisioning status
- [ ] Test: Restart a failed workspace and verify clean state transition
