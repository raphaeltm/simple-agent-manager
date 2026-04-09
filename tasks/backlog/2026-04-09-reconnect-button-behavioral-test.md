# Add Behavioral Test for AgentErrorBanner Reconnect Button

## Problem

PR #647 added a "Reconnect" button to the `AgentErrorBanner` component in `MessageBanners.tsx`. Per rule 02 (Interactive Element Test Requirement), every new button must ship with a behavioral test that renders the component, simulates the click, and asserts the outcome. This test was not included in the PR.

## Acceptance Criteria

- [ ] Test renders `AgentErrorBanner` with a mock session object (state !== 'error')
- [ ] Test simulates clicking the Reconnect button
- [ ] Test asserts `session.reconnect()` was called
- [ ] Test renders `AgentErrorBanner` with error state and verifies reconnect button appears when `showReconnect` is true
- [ ] Test verifies reconnect button does NOT appear when severity is 'fatal'

## Key Files

- `apps/web/src/components/project-message-view/MessageBanners.tsx` — component under test
- `apps/web/tests/unit/components/` — test location

## Context

Found by task-completion-validator reviewing PR #647 (Unified Agent-Workspace Lifecycle).
