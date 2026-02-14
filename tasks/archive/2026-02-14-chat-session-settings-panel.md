# Chat Session Settings Panel

**Created**: 2026-02-14
**Priority**: Medium
**Relates to**: Agent settings, ChatSession component, `packages/acp-client`

## Summary

Add an in-session settings panel for managing agent permissions and model selection. The panel should pop out from a button to the left of the chat input field. Currently there is no way for users to manage these settings per-session from within the workspace UI.

## Context

The backend already supports agent settings (`agent_settings` table, `/api/agent-settings/:agentType` endpoints) with:
- **Permission mode**: `default`, `acceptEdits`, `bypassPermissions`
- **Model selection**: Stored in agent settings

However, there's no in-workspace UI to view or change these. The existing `AgentSettingsSection` in the main Settings page is too far from the workflow. Users need quick access to these controls while actively using the agent.

## Design

- **Trigger**: Small settings/gear icon button to the left of the chat input field
- **Panel**: Slide-out or popover panel (not a full-screen overlay)
- **Contents**:
  - Permission mode selector (dropdown or segmented control)
  - Model selector (if multiple models are available)
  - Any other per-session agent configuration
- **Behavior**: Changes apply to the current session (or next session if mid-conversation)
- **Mobile**: Panel should work well on mobile — perhaps a bottom sheet pattern

## Implementation Notes

- Reuse existing agent settings API (`GET/PUT /api/agent-settings/:agentType`)
- Check how settings are currently passed to the ACP gateway (`gateway.go` fetches settings on session start)
- Consider whether settings changes should take effect immediately or on next session
- The button placement should not crowd the input area — keep it compact
