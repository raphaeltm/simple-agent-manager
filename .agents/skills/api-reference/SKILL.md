---
name: api-reference
description: 'Full API endpoint reference for SAM. Use when working on API routes, adding endpoints, writing API tests, or understanding the API surface. Trigger when asked about API endpoints, routes, or HTTP interfaces.'
---

# SAM API Endpoint Reference

Read the full reference from `.claude/skills/api-reference/SKILL.md` and provide the relevant information to the user.

The reference covers:

- Node Management (`/api/nodes/*`)
- Workspace Management (`/api/workspaces/*`)
- Project Management (`/api/projects/*`)
- Task Management (`/api/projects/:projectId/tasks/*`)
- MCP orchestration (`wait_for_subtasks`, `dispatch_task`, task inspection)
- MCP private incident backlog tools (`list_incident_queue`, `get_incident`, `claim_incident`, `resolve_incident`)
- Agent Sessions (`/api/workspaces/:id/agent-sessions/*`)
- Message-anchored chat comments (`/api/projects/:projectId/sessions/:sessionId/comments*`)
- Agent Settings (`/api/agent-settings/*`)
- Notifications (`/api/notifications/*`)
- Automation triggers (`/api/projects/:projectId/triggers/*`, `/api/webhooks/ingest`)
- VM Communication callbacks
- Terminal Access
- Git Integration (VM Agent direct)
- File Browser (VM Agent direct)
- Voice Transcription
- Authentication (BetterAuth)
- Credentials
- GitHub Integration
- Error Format
