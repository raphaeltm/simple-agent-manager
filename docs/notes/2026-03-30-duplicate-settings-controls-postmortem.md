# Post-Mortem: Duplicate Settings Controls on Project Settings Page

**Date**: 2026-03-30
**Severity**: UX bug (confusing, out-of-sync controls)

## What Broke

The project settings page displayed two separate controls for the same API fields when a user had 2+ configured providers:

1. **`defaultProvider`**: A toggle-button section ("Default Cloud Provider") and a dropdown in the ScalingSettings component both managed `project.defaultProvider`. They used different interaction patterns and were out of sync until page reload.

2. **`nodeIdleTimeoutMs`**: A range slider in the "Compute Lifecycle" section and a numeric input in ScalingSettings "Node Scheduling" both managed `project.nodeIdleTimeoutMs`. Again, out of sync.

## Root Cause

PR #558 ("Per-project scaling parameters and provider-aware locations") added the `ScalingSettings` component with provider/location dropdowns and scaling parameter fields. The component correctly managed `defaultProvider`, `defaultLocation`, and `nodeIdleTimeoutMs`. However, the pre-existing "Default Cloud Provider" toggle section and the "Compute Lifecycle" section's node idle timeout slider in `ProjectSettings.tsx` were not removed.

The implementing agent added new controls without auditing whether existing controls already managed the same fields.

## Timeline

1. Pre-existing: `ProjectSettings.tsx` had toggle buttons for `defaultProvider` and sliders for `nodeIdleTimeoutMs`
2. PR #558 merged: Added `ScalingSettings.tsx` with dropdown for `defaultProvider`/`defaultLocation` and numeric input for `nodeIdleTimeoutMs`
3. Both controls visible on the same page, managing the same API fields with different UIs

## Why It Wasn't Caught

The UI/UX specialist review (dispatched during Phase 5 of PR #558) flagged the duplication as finding #10. However, the PR was already merged by the time the review completed. The review agent was dispatched but the implementing agent proceeded through Phases 6-7 without waiting for all reviewers to report back.

This is a direct violation of the Phase 5 review completion gate documented in `.claude/rules/14-do-workflow-persistence.md`, which requires all dispatched reviewers to show `PASS` or `ADDRESSED` before advancing past Phase 5.

## Class of Bug

**Additive UI duplication** — adding a new UI section that manages a field already managed by an existing section, without removing or consolidating the old one. This is a common failure mode when:

- A new component is created to improve the UX of an existing control
- The agent focuses on building the new component without searching for pre-existing controls
- No automated check exists to detect two controls managing the same API field

## Process Fix

1. **New rule added**: `.claude/rules/24-no-duplicate-ui-controls.md` — requires agents to grep for existing controls managing the same API field before adding new form fields or settings controls. If a duplicate is found, consolidate into one canonical location.

2. **Existing rule reinforced**: The Phase 5 review tracker in `.claude/rules/14-do-workflow-persistence.md` already requires waiting for all reviewers. This incident reinforces why that gate exists — the review that would have caught this bug was dispatched but not waited for.
