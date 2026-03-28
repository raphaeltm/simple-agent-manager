# Update Documentation: Ideas Rebranding & Recent Features

## Problem

The public documentation (apps/www/src/content/docs/) was last significantly updated on March 17, 2026. Since then, major user-facing changes have shipped:

1. **Tasks → Ideas rebranding**: The UI now shows "Ideas" instead of "Tasks." Status labels changed to Exploring/Ready/Executing/Done/Parked. Tasks remain as the underlying data model but are no longer a user-facing concept.
2. **File browsing in chat**: File browser, diff viewer, git status panel in project chat sessions.
3. **File upload/download**: Attach files to chat sessions, download from workspace.
4. **Image rendering in file browser**: Inline image preview with fit-to-panel/1:1 toggle.
5. **Global persistent audio player**: TTS audio survives page navigation.
6. **Chat-idea association**: Ideas can be linked to chat sessions.
7. **Message materialization + FTS5 search**: Full-text search across chat messages.
8. **Analytics forwarding (Phase 4)**: External event forwarding to Segment/GA4.
9. **License change**: MIT → AGPL-3.0.

The docs should follow the Diátaxis framework:
- **Tutorials** = learning-oriented (Quickstart)
- **How-to Guides** = task-oriented (Guides section)
- **Reference** = information-oriented (Reference section)
- **Explanation** = understanding-oriented (Architecture section)

## Research Findings

### Files requiring updates (priority order):

1. **concepts.mdx** — "Tasks" section must become "Ideas" with new status names and user-facing framing
2. **guides/task-execution.md** — Rename to reflect ideas/execution workflow; remove "task" as user-facing term
3. **guides/chat-features.md** — Add file browsing, file upload/download, image viewer, global audio player
4. **index.mdx** — Update card descriptions to say "ideas" instead of "tasks"
5. **overview.mdx** — Change "Submit a task" step to match current UX; add file features to key features list
6. **guides/agents.md** — Update MCP tools list (idea-related tools added: create_idea, update_idea, list_ideas, etc.)
7. **guides/notifications.md** — Minor terminology updates
8. **guides/creating-workspaces.md** — Update "Task-Based Workspaces" section
9. **reference/api.md** — Add file proxy endpoints, idea endpoints
10. **reference/configuration.md** — Add file upload/download/raw config vars, analytics forwarding vars, idea context vars
11. **architecture/overview.md** — Minor wording updates
12. **astro.config.mjs** — Update sidebar entry label from "Task Execution" if renamed

### User-facing terminology mapping:
- "Task" (internal) → "Idea" (user-facing)
- draft → Exploring
- ready → Ready
- queued/delegated/in_progress → Executing
- completed → Done
- failed/cancelled → Parked

### Current navigation (apps/web):
- Chat, Ideas, Activity, Notifications, Settings

## Implementation Checklist

- [ ] Update `concepts.mdx`: Rename "Tasks" → "Ideas", update lifecycle statuses, update description
- [ ] Rewrite `guides/task-execution.md`: Reframe as "How Ideas Become Code" or similar; keep technical details but with idea-first framing
- [ ] Update `guides/chat-features.md`: Add file browsing, upload/download, image viewer, global audio player sections
- [ ] Update `index.mdx`: Change card descriptions (tasks → ideas)
- [ ] Update `overview.mdx`: Change step 6, update key features list with file features
- [ ] Update `guides/agents.md`: Update MCP tools table with idea-related tools
- [ ] Update `guides/notifications.md`: Minor terminology (task → idea where user-facing)
- [ ] Update `guides/creating-workspaces.md`: Update "Task-Based Workspaces" section
- [ ] Update `reference/api.md`: Add file proxy endpoints, update task endpoint descriptions
- [ ] Update `reference/configuration.md`: Add new config variables for file features, analytics forwarding
- [ ] Update `architecture/overview.md`: Minor updates
- [ ] Update `astro.config.mjs` sidebar if guide is renamed
- [ ] Build the www package to verify no broken links or build errors
- [ ] Verify Diátaxis alignment: each doc page is primarily one type

## Acceptance Criteria

- [ ] No user-facing documentation refers to "tasks" as the primary concept — "ideas" is used instead
- [ ] All features shipped since March 17 are documented
- [ ] `pnpm --filter @simple-agent-manager/www build` passes
- [ ] Documentation follows Diátaxis principles (each page is one type)
- [ ] Sidebar navigation reflects updated page titles
