# Split api.ts (2,255 lines) into Domain-Specific Modules

## Problem

`apps/web/src/lib/api.ts` is 2,255 lines — the largest TypeScript file in the web app, far exceeding the mandatory 800-line split threshold (rule 18). It needs to be split by resource domain into `apps/web/src/lib/api/` with a barrel `index.ts`.

## Research Findings

### Current structure
The file has clear section headers marking domain boundaries:
- **Shared helpers** (lines 1-123): `API_URL`, `ApiClientError`, `request<T>()`
- **Auth** (lines 125-130): `getCurrentUser`
- **Credentials** (lines 132-150): provider credential CRUD
- **GCP OIDC** (lines 152-198): GCP setup types and functions
- **Providers** (lines 200-206): `getProviderCatalog`
- **GitHub** (lines 208-239): installations, repos, branches
- **Account Map / Dashboard** (lines 241-320): `getAccountMap`, `listActiveTasks`
- **Projects** (lines 322-412): project CRUD, runtime config
- **Tasks** (lines 414-715): task types, submit, CRUD, attachments, events, session links
- **Chat Sessions** (lines 717-875): session types, CRUD, summarize, follow-up
- **Activity Events** (lines 877-910): `listActivityEvents`
- **Nodes** (lines 912-1000): node CRUD, logs, events, system info
- **Workspaces** (lines 1002-1088): workspace CRUD, lifecycle
- **Port Detection** (lines 1090-1116): `listWorkspacePorts`
- **Agent Sessions** (lines 1118-1200): agent session management
- **Terminal** (lines 1202-1210): `getTerminalToken`
- **Workspace Tabs** (lines 1212-1234): `getWorkspaceTabs`
- **Agents** (lines 1236-1282): agent types, credentials
- **URL helpers** (lines 1284-1310): transcribe, TTS, client-errors, analytics URLs
- **Agent Settings** (lines 1312-1334): agent settings CRUD
- **Git Integration** (lines 1336-1558): git status, diff, file viewing, worktrees
- **Admin** (lines 1560-1586): user management
- **Admin Observability** (lines 1588-1656): errors, health, logs
- **Notifications** (lines 1658-1717): notification CRUD, preferences, WS URL
- **Deployment** (lines 1719-1775): GCP deployment
- **Cached Commands** (lines 1776-1806): command caching
- **Agent Profiles** (lines 1808-1847): profile CRUD
- **Admin Analytics** (lines 1849-1961): DAU, events, funnel, feature adoption, geo, retention, traffic, forwarding
- **Session File Proxy** (lines 1961-2037): session file/git proxy
- **File Upload/Download** (lines 2039-2095): session file upload/download
- **Smoke Test** (lines 2097-2142): smoke test tokens
- **Browser Sidecar** (lines 2143-2255): Neko browser sidecar

### Dependencies
- `API_URL` constant is used directly in ~12 functions (WebSocket URLs, file upload/download, URL builders)
- `request<T>()` is used by nearly all functions
- `ApiClientError` is exported and used by consumers
- All 57 consumer files use relative imports: `from '../lib/api'` or `from '../../lib/api'`

### Planned module split
1. `api/client.ts` (~95 lines) — `API_URL`, `ApiClientError`, `request<T>()`
2. `api/auth.ts` (~15 lines) — `getCurrentUser`
3. `api/credentials.ts` (~85 lines) — provider credentials, GCP OIDC
4. `api/github.ts` (~35 lines) — GitHub installations, repos, branches
5. `api/providers.ts` (~10 lines) — `getProviderCatalog`
6. `api/projects.ts` (~105 lines) — project CRUD, runtime config, account map
7. `api/dashboard.ts` (~15 lines) — `listActiveTasks`
8. `api/tasks.ts` (~310 lines) — task types, submit, CRUD, attachments, events, session links
9. `api/sessions.ts` (~170 lines) — chat sessions, summarize, follow-up, activity events
10. `api/nodes.ts` (~100 lines) — node CRUD, logs, events, system info
11. `api/workspaces.ts` (~240 lines) — workspace CRUD, lifecycle, ports, agent sessions, terminal, tabs
12. `api/agents.ts` (~110 lines) — agent types, credentials, settings, profiles, URL helpers
13. `api/files.ts` (~240 lines) — git integration, session file proxy, file upload/download
14. `api/admin.ts` (~280 lines) — admin users, observability, analytics
15. `api/notifications.ts` (~65 lines) — notification CRUD, preferences, WS URL
16. `api/deployment.ts` (~60 lines) — GCP deployment
17. `api/misc.ts` (~80 lines) — cached commands, smoke test, browser sidecar
18. `api/index.ts` (~20 lines) — barrel re-exports

## Implementation Checklist

- [ ] Create `apps/web/src/lib/api/` directory
- [ ] Extract `client.ts` with `API_URL`, `ApiClientError`, `request<T>()`
- [ ] Extract `auth.ts`
- [ ] Extract `credentials.ts` (provider credentials + GCP OIDC)
- [ ] Extract `github.ts`
- [ ] Extract `providers.ts`
- [ ] Extract `projects.ts` (project CRUD + runtime config + account map)
- [ ] Extract `dashboard.ts`
- [ ] Extract `tasks.ts` (task types, submit, CRUD, attachments, events, session links)
- [ ] Extract `sessions.ts` (chat sessions + activity events)
- [ ] Extract `nodes.ts`
- [ ] Extract `workspaces.ts` (workspace CRUD + lifecycle + ports + agent sessions + terminal + tabs)
- [ ] Extract `agents.ts` (agent types, credentials, settings, profiles, URL helpers)
- [ ] Extract `files.ts` (git integration + session file proxy + file upload/download)
- [ ] Extract `admin.ts` (admin users + observability + analytics)
- [ ] Extract `notifications.ts`
- [ ] Extract `deployment.ts`
- [ ] Extract `misc.ts` (cached commands, smoke test, browser sidecar)
- [ ] Create barrel `index.ts` that re-exports everything
- [ ] Delete original `api.ts`
- [ ] Verify no file exceeds 500 lines
- [ ] Run `pnpm typecheck` — all green
- [ ] Run `pnpm lint` — all green
- [ ] Run `pnpm test` — all green
- [ ] Run `pnpm build` — all green

## Acceptance Criteria

- [ ] Original `apps/web/src/lib/api.ts` is removed
- [ ] All functions/types/classes are available via `apps/web/src/lib/api/index.ts`
- [ ] No domain module exceeds 500 lines
- [ ] All 57 consumer files work without import changes
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass
- [ ] Zero behavioral changes — pure refactor

## References

- `.claude/rules/18-file-size-limits.md`
- `apps/web/src/lib/api.ts`
