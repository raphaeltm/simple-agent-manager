# Project Chat First

## Rule: Project Chat Is the Primary UX Surface

The app is chat-first (spec 022). The **project chat** is the primary way users interact with workspaces, agents, files, and tools. The workspace view is secondary — most users access everything through the project chat without ever navigating to a standalone workspace page.

When building or modifying any feature that has a user-facing component, the **project chat integration** must be designed and implemented first. The workspace view integration is secondary and can follow.

### What This Means in Practice

| Decision | Project Chat First | NOT This |
|----------|-------------------|----------|
| **Where to render a new tool/panel** | Project chat session header or panel first, workspace sidebar second | Workspace sidebar only, with "we'll add chat later" |
| **Which mode to wire up first** | Session-mode (projectId + sessionId) | Workspace-mode (workspaceId only) |
| **Where to test the UX** | Project chat flow on mobile and desktop | Workspace page only |
| **Where to put action buttons** | Chat session header action row | Workspace sidebar collapsible section |
| **API route priority** | `/projects/:id/sessions/:sessionId/*` routes | `/workspaces/:id/*` routes only |

### Why This Rule Exists

The Neko browser sidecar (PR #568) shipped with full backend support for both session-mode and workspace-mode, but the UI was only wired into the workspace sidebar. Since the app is chat-first and most users never visit the workspace view directly, the feature was effectively invisible. The API routes, hook, and component all supported session-mode — but nobody rendered it in the project chat.

This happens because the workspace view is simpler to integrate with (direct workspaceId, no session resolution). Agents default to the easier path. This rule forces the harder but more important path first.

### Required Steps for Any User-Facing Feature

1. **Design for project chat first.** How will users discover and use this feature from within a chat session? If the answer is "they won't — they go to the workspace view," redesign.

2. **Wire up session-mode before workspace-mode.** If the feature has both session-mode (projectId + sessionId) and workspace-mode (workspaceId) interfaces, implement and test session-mode first.

3. **Test from the chat flow.** Playwright visual audits and manual testing should start from the project chat page, not the workspace page.

4. **Workspace view is additive.** After the project chat integration is complete, adding the feature to the workspace sidebar/view is fine — but it's not a substitute for the chat integration.

### Exceptions

Features that are inherently workspace-management-only (e.g., node provisioning, workspace creation/deletion, recovery mode) are exempt. If the feature operates on the workspace itself rather than the user's interaction with an agent, the workspace view may be primary.

### Quick Compliance Check

Before committing a new user-facing feature:
- [ ] Feature is accessible from the project chat session (not just workspace view)
- [ ] Session-mode API routes and hooks are wired up (if applicable)
- [ ] Playwright tests include the project chat flow
- [ ] If workspace-only: documented justification for why chat integration doesn't apply
