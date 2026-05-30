# CLI UX Overhaul

## Problem

The SAM CLI is task-oriented with raw ULID requirements. Users must know project IDs and use "task" terminology. The CLI needs transformation into a user-friendly hierarchical command interface mirroring the web app's navigation.

## Research Findings

### Current State
- CLI lives in `packages/cli/internal/cli/` with ~15 Go files
- Commands: `auth login/status`, `task submit/status`, `tasks dispatch`, `chat`, `workspace forward/ports`, `runner doctor`
- All commands require `--project <ULID>` or positional project ID
- No project name resolution, no interactive selection, no stored project context
- Test infrastructure: `testRuntime()`, `captureJSONRequest()`, `fakeEnv`, `fakeRunner` in `test_helpers_test.go`
- Output: `writeOutput()` supports text/JSON modes, `writeOrFail()` helper pattern

### API Endpoints (all confirmed existing)
1. `GET /api/projects` → project list
2. `GET /api/projects/:id` → project detail
3. `GET /api/projects/:id/sessions` → chat sessions
4. `GET /api/projects/:id/sessions/:sid/messages` → session messages
5. `GET /api/projects/:id/tasks` → tasks/ideas (filter by status)
6. `GET /api/projects/:id/library` → library files
7. `GET /api/projects/:id/knowledge` → knowledge entities
8. `GET /api/notifications` → notifications
9. `GET /api/projects/:id/triggers` → triggers
10. `GET /api/projects/:id/agent-profiles` → agent profiles
11. `GET /api/projects/:id/activity` → activity events
12. `GET /api/nodes` → infrastructure nodes

### Design Decisions
- Tasks hidden from users → "chats" and "ideas" terminology
- ULIDs never required → accept name, prefix (5+ chars), or full ULID
- `--project <ref>` flag overrides active project
- All commands except `sam chat new` are read-only
- Backward compat: old commands work but hidden from help
- Simple line-based interactive picker (no `golang.org/x/term` dependency)
- Table output with aligned columns, truncated IDs (7 chars), relative times

### Key Rules
- `.claude/rules/36-cli-quality.md`: High Go + QA bar, boundary tests, SonarCloud compliance
- Policy: CLI must meet high Go and QA-quality standards

## Implementation Checklist

### Phase A: Infrastructure (types, client, table formatting, config)
- [ ] A1: Add response types to `types.go` (Project, Session, Message, Idea, LibraryFile, KnowledgeEntity, Notification, Trigger, AgentProfile, ActivityEvent, Node, and list wrappers)
- [ ] A2: Add table formatter to new `table.go` (PrintTable, FormatRelativeTime, TruncateID)
- [ ] A3: Add ~12 API client methods to `client.go` (ListProjects, GetProject, ListSessions, GetSessionMessages, ListIdeas, ListLibraryFiles, ListKnowledge, ListNotifications, ListTriggers, ListProfiles, ListActivity, ListNodes)
- [ ] A4: Extend CLIConfig with ActiveProjectID/ActiveProjectName, add SetActiveProject/ClearActiveProject
- [ ] A5: Create `project_resolve.go` with ResolveProject (ULID→as-is, prefix→unique match, name→case-insensitive, empty→config default)

### Phase B: Core commands
- [ ] B1: `sam projects` — list all projects as table
- [ ] B2: `sam project use [name]` — interactive picker (line-based) or direct resolution, save to config
- [ ] B3: `sam project [ref]` — show project detail
- [ ] B4: `sam status` — dashboard overview (current project + chats + nodes, or project list if none selected)

### Phase C: Project-scoped commands
- [ ] C1: `sam chat` — list chat sessions for active project
- [ ] C2: `sam chat new "message"` — start new chat (POST /api/projects/:id/tasks/submit with mode=conversation)
- [ ] C3: `sam chat <id>` — show messages from a session
- [ ] C4: `sam ideas` — list ideas (GET /api/projects/:id/tasks filtered)
- [ ] C5: `sam library` — list library files
- [ ] C6: `sam context` — list knowledge entities
- [ ] C7: `sam notifications` — list notifications
- [ ] C8: `sam triggers` — list triggers
- [ ] C9: `sam profiles` — list agent profiles
- [ ] C10: `sam activity` — recent activity feed
- [ ] C11: `sam nodes` — list infrastructure nodes

### Phase D: Command dispatch & help
- [ ] D1: Update `run.go` with routing for all new commands, project resolution middleware
- [ ] D2: Update help text to show new command structure (hide old task/tasks commands)
- [ ] D3: Ensure backward compat — old `task submit`, `task status`, `tasks dispatch`, `chat <projectId>` still work

### Phase E: Tests
- [ ] E1: Table formatter tests (alignment, truncation, relative time formatting)
- [ ] E2: Project resolution tests (ULID, prefix, name, ambiguous, not-found, config default)
- [ ] E3: Interactive picker tests (mock stdin, numbered selection, filter)
- [ ] E4: Boundary tests for every new command (injected HTTP client, text + JSON output)
- [ ] E5: Backward compatibility tests (old commands still work)

### Phase F: Documentation
- [ ] F1: Update `docs/cli.md` with new command structure

## Acceptance Criteria

1. `sam projects` lists all projects in aligned table format
2. `sam project use SAM` sets default project by name (case-insensitive)
3. `sam project use` with interactive terminal shows numbered picker
4. `sam status` shows dashboard with current project context
5. `sam chat` lists chat sessions; `sam chat new "msg"` starts a new chat
6. `sam chat <id>` shows session messages
7. All read-only commands work: ideas, library, context, notifications, triggers, profiles, activity, nodes
8. `--project <ref>` overrides active project on any project-scoped command
9. Old commands (`task submit`, `task status`, `tasks dispatch`) still work
10. No "task" terminology in user-facing output
11. ULIDs truncated to 7 chars in display; full ULIDs never required as input
12. All tests pass with `go test -race ./...`
13. `--json` flag works for all new commands

## References

- Idea: 01KSWXTX60YSH2KXX0CYF5NAZQ
- CLI quality rules: `.claude/rules/36-cli-quality.md`
- Existing CLI code: `packages/cli/internal/cli/`
- Web app nav: `apps/web/src/components/NavSidebar.tsx`
