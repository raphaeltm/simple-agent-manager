# Event-Driven Triggers — Task 4: Chat Integration + Polish

## Problem Statement

Tasks 1-3 built the full trigger backend and management UI. But triggers are invisible in the day-to-day chat flow. Users can't tell which tasks were triggered automatically, can't quickly access triggers from the chat, and agents can't create triggers via MCP.

## Research Findings

### Key Files to Modify

**Shared types:**
- `packages/shared/src/types/task.ts` — Task interface missing `triggeredBy`, `triggerId`, `triggerExecutionId` fields (DB has them, shared type does not)

**API:**
- `apps/api/src/lib/mappers.ts` — `toTaskResponse()` doesn't map trigger fields
- `apps/api/src/routes/tasks/crud.ts` — Task detail endpoint needs trigger info enrichment
- `apps/api/src/routes/mcp/index.ts` — Add `create_trigger` case
- `apps/api/src/routes/mcp/tool-definitions.ts` — Add `create_trigger` tool definition

**UI:**
- `apps/web/src/pages/project-chat/index.tsx` — Sidebar header (add clock button)
- `apps/web/src/pages/project-chat/SessionItem.tsx` — Badge for triggered sessions
- `apps/web/src/pages/project-chat/SessionList.tsx` — Pass trigger info to SessionItem
- `apps/web/src/pages/IdeasPage.tsx` — IdeaCard needs trigger badge
- `apps/web/src/pages/TaskDetail.tsx` — Trigger info banner
- `apps/web/src/components/project/SettingsDrawer.tsx` — Automation section
- `apps/web/src/components/project-message-view/SessionHeader.tsx` — Trigger info in expanded details

### Patterns Observed

- Sidebar header buttons: `shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors`
- Session badges: `badge` prop on SessionItem accepts ReactNode
- Settings drawer sections: `<section className="grid gap-3">` with h3 header + content
- MCP tools: defined in tool-definitions.ts, handled in index.ts switch, implemented in separate files

## Implementation Checklist

### Backend

- [ ] 1. Add `triggeredBy`, `triggerId`, `triggerExecutionId` to shared `Task` interface
- [ ] 2. Update `toTaskResponse()` mapper to include trigger fields
- [ ] 3. Enrich task detail response with trigger info (name, schedule, execution sequence)
- [ ] 4. Add `create_trigger` MCP tool definition in tool-definitions.ts
- [ ] 5. Implement `create_trigger` MCP handler in new trigger-tools.ts
- [ ] 6. Wire up handler in mcp/index.ts

### UI — Chat Integration

- [ ] 7. Add trigger quick-access dropdown to project chat sidebar header (Clock icon button with popover)
- [ ] 8. Add "Automation" section to SettingsDrawer with trigger count + link
- [ ] 9. Add clock badge to SessionItem for triggered sessions
- [ ] 10. Add trigger info banner to SessionHeader expanded details

### UI — Task/Idea Pages

- [ ] 11. Add trigger badge to IdeaCard (kanban) for triggered tasks
- [ ] 12. Add trigger info section to TaskDetail page

### Tests

- [ ] 13. Unit test for MCP create_trigger tool
- [ ] 14. Behavioral test for triggered task badge in IdeaCard
- [ ] 15. Behavioral test for chat header trigger dropdown
- [ ] 16. Test that task detail response includes trigger info

## Acceptance Criteria

- [ ] Tasks with `triggeredBy !== 'user'` show a clock icon badge in the session list and kanban board
- [ ] Task detail page shows trigger name, schedule, and execution sequence number with links
- [ ] Chat header has a clock button that opens a popover showing active triggers
- [ ] Settings drawer has an "Automation" section with trigger count and manage link
- [ ] MCP `create_trigger` tool works — creates a trigger and returns its details
- [ ] Task detail API response includes trigger and execution info when applicable
- [ ] All interactive elements have behavioral tests
