# Quick Workspace Launch & Management UX

## Problem

Launching and managing workspaces requires too many clicks and navigation steps. From the project page, you need to open settings, navigate to the overview view, then click "Launch Workspace." There's no quick way to start/stop/manage workspaces from the primary project interface (the chat page) or the dashboard.

## Context

- Discovered during staging testing on 2026-03-02
- The chat-first UX (spec 022) moved the project page to a chat interface, but workspace controls were pushed into a settings drawer sub-view
- Common workflow: user wants to quickly launch a workspace, check its status, or open a terminal — shouldn't require 3+ clicks through settings/overview

## Desired Behavior

- One-click workspace launch from the project chat page (e.g., a button in the header or sidebar)
- Workspace status visible at a glance from the project page (running/creating/stopped)
- Quick access to terminal/agent sessions from the project page without navigating to a separate workspace detail view
- Dashboard should show active workspace status per project

## Acceptance Criteria

- [ ] Workspace launch accessible from the project chat page in 1 click
- [ ] Active workspace status shown on project page header/sidebar
- [ ] Quick-action buttons for common workspace operations (stop, restart, open terminal)
- [ ] Dashboard project cards show workspace status indicator
- [ ] Existing overview/settings views still accessible for advanced management
