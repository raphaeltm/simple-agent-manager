# Deep Git Worktree Integration — Exploration

## What Are Git Worktrees?

`git worktree` lets you check out multiple branches of the same repo simultaneously into separate directories, all sharing a single `.git` object store. Instead of stashing/committing to switch branches, you just switch directories.

```
/workspaces/my-repo/            # main branch (primary worktree)
/workspaces/my-repo-feature-x/  # feature-x branch (linked worktree)
/workspaces/my-repo-bugfix-42/  # bugfix-42 branch (linked worktree)
```

Each worktree has its own working tree, index, and HEAD — but they share commits, objects, and refs. You can't check out the same branch in two worktrees simultaneously (git enforces this).

---

## Current Architecture: One Repo Directory = One Context

Today, every subsystem in SAM is hardwired to a single directory per workspace:

| Subsystem | How it gets its directory | Where it runs |
|-----------|--------------------------|---------------|
| **Terminal (PTY)** | `WorkspaceRuntime.ContainerWorkDir` → PTY Manager `WorkDir` | `docker exec -w /workspaces/my-repo` |
| **File Browser** | `resolveContainerForWorkspace()` → `ContainerWorkDir` | `docker exec -w /workspaces/my-repo find ...` |
| **Git Viewer** | `resolveContainerForWorkspace()` → `ContainerWorkDir` | `docker exec -w /workspaces/my-repo git status` |
| **Agent (ACP)** | `SessionHost.config.ContainerWorkDir` → `NewSession(Cwd: ...)` | `docker exec -w /workspaces/my-repo claude-code-acp` |
| **File Read/Write** | Agent sends absolute paths (rooted in its CWD) | `docker exec cat /workspaces/my-repo/...` |

The host workspace directory is derived from the canonical workspace ID, while
the default container CWD is repo-oriented:
```
workspaceId "WS_ABC123", repository "org/my-repo" → host: /workspace/WS_ABC123 → container: /workspaces/my-repo
```

**The core insight: "context" in SAM = a directory path.** If we can make that path dynamic and switchable, everything follows.

---

## The Vision: Worktree-Scoped Context Switching

### What the user would see

The workspace page gets a new concept: the **active worktree**. A worktree selector appears in the header (next to the repo@branch display). Everything below it — terminal, file browser, git viewer, chat sessions — operates in the selected worktree's directory.

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Dashboard    my-repo    [main ▼]  [📁] [git] [☰]           │
│                             ├─ main (primary)                   │
│                             ├─ feature-auth                     │
│                             ├─ bugfix-login                     │
│                             └─ + New worktree...                │
├─────────────────────────────────────────────────────────────────┤
│  [Terminal 1] [Terminal 2] [Claude ①] [+]                       │
│                                                                 │
│  ~/my-repo-feature-auth $ git log --oneline -3                  │
│  a1b2c3d Add OAuth handler                                      │
│  ...                                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Key UX decisions

1. **Worktree selector in the header** — a dropdown showing all worktrees, with the active one highlighted. Always visible when the workspace is running.

2. **Switching worktrees is instant** — no container rebuild, no reconnect. The frontend just tells the backend "I'm now looking at worktree X" and all subsequent operations use that path.

3. **Terminals are worktree-scoped** — new terminals open in the selected worktree's directory. Existing terminals keep their CWD (they don't magically teleport). The tab strip could show which worktree each terminal belongs to.

4. **Chat sessions are worktree-scoped** — each Claude session has a worktree affinity. When you create a new chat in "feature-auth", Claude's CWD is `/workspaces/my-repo-feature-auth`. You can have one Claude working on `main` and another on `feature-auth` simultaneously.

5. **File browser follows the active worktree** — opening the file browser shows the selected worktree's files. Git viewer shows that worktree's changes.

6. **Creating a worktree** — a small modal: pick a branch (or create one), optionally name the worktree directory. Runs `git worktree add` inside the container.

7. **Removing a worktree** — context menu on the worktree dropdown. Runs `git worktree remove`. Warns if there are uncommitted changes.

---

## What It Would Take — Layer by Layer

### Layer 1: VM Agent Backend (Go)

#### New concept: WorktreeInfo

```go
type WorktreeInfo struct {
    Path       string // container path, e.g. /workspaces/my-repo-feature-auth
    Branch     string // e.g. feature-auth
    IsPrimary  bool   // true for the original clone directory
    HostPath   string // host path, e.g. /workspace/WS_ABC123-wt-feature-auth
}
```

#### New VM Agent endpoints

```
GET  /workspaces/:id/worktrees           — List all worktrees
POST /workspaces/:id/worktrees           — Create a new worktree (branch, path)
DELETE /workspaces/:id/worktrees/:name   — Remove a worktree
```

These would run `git worktree list --porcelain`, `git worktree add`, and `git worktree remove` inside the container via `docker exec`.

#### Modify existing endpoints to accept worktree context

Every endpoint that currently uses `ContainerWorkDir` needs to accept an optional `worktree` query parameter:

```
GET /workspaces/:id/files/list?path=.&worktree=/workspaces/my-repo-feature-auth
GET /workspaces/:id/git/status?worktree=/workspaces/my-repo-feature-auth
GET /workspaces/:id/git/diff?path=foo.ts&worktree=/workspaces/my-repo-feature-auth
```

The backend validates that the requested worktree path is a legitimate worktree (listed by `git worktree list`) to prevent path traversal, then uses it as the `workDir` for `docker exec` instead of the default `ContainerWorkDir`.

**Security consideration**: The worktree parameter must be validated against actual `git worktree list` output. We can't just accept arbitrary paths — that would be a directory traversal vulnerability.

#### PTY sessions: worktree-aware creation

The PTY manager needs a way to spawn new sessions with a custom CWD:

```go
// Current: always uses manager's configured WorkDir
func (m *Manager) NewSession(id string) (*Session, error)

// New: optional CWD override
func (m *Manager) NewSessionWithWorkDir(id string, workDir string) (*Session, error)
```

The terminal WebSocket endpoint would accept an optional `worktree` query param:
```
wss://ws-xxx.domain/terminal/ws/multi?token=JWT&worktree=/workspaces/my-repo-feature-auth
```

New terminal sessions created on this connection would use the specified worktree as CWD.

#### Agent sessions: worktree-scoped ACP

The `SessionHost` currently hardcodes `ContainerWorkDir` as the CWD for `NewSession()`. This needs to be parameterizable:

```go
// agent_ws.go: when creating a new agent session
cfg.ContainerWorkDir = requestedWorktreePath  // from the WebSocket URL or create-session request
```

The ACP `NewSession` call would then pass the worktree path:
```go
h.acpConn.NewSession(ctx, acpsdk.NewSessionRequest{
    Cwd: worktreePath,  // /workspaces/my-repo-feature-auth instead of /workspaces/my-repo
})
```

This means each agent session is bound to a specific worktree. You could have:
- Session 1: Claude working in `/workspaces/my-repo` (main)
- Session 2: Claude working in `/workspaces/my-repo-feature-auth` (feature-auth)

#### Estimated backend changes

| File | Change | Complexity |
|------|--------|------------|
| `server/worktrees.go` (new) | New endpoints: list/create/delete worktrees | Medium |
| `server/git.go` | Accept `worktree` param, validate, use as workDir | Low |
| `server/files.go` | Accept `worktree` param, validate, use as workDir | Low |
| `server/websocket.go` | Accept `worktree` param for new PTY sessions | Low |
| `pty/manager.go` | `NewSessionWithWorkDir()` method | Low |
| `server/agent_ws.go` | Pass worktree path to SessionHost config | Low |
| `acp/session_host.go` | Use configurable CWD instead of hardcoded ContainerWorkDir | Low |
| `server/workspace_routing.go` | Worktree validation helper (against git worktree list) | Medium |

### Layer 2: Frontend (React/TypeScript)

#### New state: active worktree

The `Workspace` page needs new state:

```typescript
const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
const [activeWorktree, setActiveWorktree] = useState<string | null>(null); // path

interface WorktreeInfo {
  path: string;       // /workspaces/my-repo-feature-auth
  branch: string;     // feature-auth
  isPrimary: boolean; // true for original clone
}
```

This could also be a URL search param (`?worktree=feature-auth`) for deep-linkability.

#### Worktree selector component

A dropdown in the header, next to the repo@branch display:

```tsx
<WorktreeSelector
  worktrees={worktrees}
  active={activeWorktree}
  onSelect={(wt) => setActiveWorktree(wt.path)}
  onCreate={(branch) => createWorktree(branch)}
  onRemove={(wt) => removeWorktree(wt.path)}
/>
```

Design considerations:
- Show branch name prominently, with path as secondary info
- Color-code or badge the primary worktree
- "New worktree" action at the bottom with branch picker
- Confirmation dialog for remove (especially if dirty)

#### Propagate worktree to all child components

Every component that talks to the VM Agent needs the active worktree path:

```tsx
// File browser
<FileBrowserPanel
  workspaceUrl={workspaceUrl}
  workspaceId={id}
  token={terminalToken}
  worktree={activeWorktree}   // NEW
  ...
/>

// Git viewer
<GitChangesPanel
  workspaceUrl={workspaceUrl}
  workspaceId={id}
  token={terminalToken}
  worktree={activeWorktree}   // NEW
  ...
/>

// Chat session — worktree is set at creation time
<ChatSession
  workspaceId={id}
  workspaceUrl={workspaceUrl}
  sessionId={sessionId}
  worktree={sessionWorktree}  // NEW — bound at session creation
  ...
/>
```

#### API client changes

All VM Agent API calls need the optional worktree parameter:

```typescript
// Current
getFileList(workspaceUrl, workspaceId, token, path)
// New
getFileList(workspaceUrl, workspaceId, token, path, worktree?)

// Current
getGitStatus(workspaceUrl, workspaceId, token)
// New
getGitStatus(workspaceUrl, workspaceId, token, worktree?)
```

#### Terminal worktree awareness

Two approaches:

**Option A: Worktree-scoped terminal tabs** — when you switch worktrees, you see only terminals for that worktree. New terminals open in the active worktree. Simple but restrictive.

**Option B: Worktree-labeled terminal tabs** — all terminals visible always, but each tab shows its worktree badge. New terminals open in the active worktree. More flexible, matches how developers actually work (you often want to see terminal output from multiple branches).

**Recommendation: Option B.** Developers frequently run builds in one worktree while editing in another. Hiding terminals on worktree switch would be disorienting.

Tab strip would look like:
```
[main: Terminal 1] [feat: Terminal 2] [main: Claude ①] [feat: Claude ②] [+]
```

#### Chat session worktree binding

When creating a new agent session, the active worktree is recorded:

```typescript
// Create session API call
createAgentSession(workspaceId, {
  agentType: 'claude-code',
  worktree: activeWorktree,  // NEW
})
```

The session is then permanently bound to that worktree. The chat tab shows the worktree badge. Claude operates in that directory for the session's lifetime.

#### Estimated frontend changes

| File | Change | Complexity |
|------|--------|------------|
| `components/WorktreeSelector.tsx` (new) | Dropdown with create/remove actions | Medium |
| `pages/Workspace.tsx` | Add worktree state, selector, propagation | Medium |
| `components/FileBrowserPanel.tsx` | Accept and pass `worktree` param | Low |
| `components/GitChangesPanel.tsx` | Accept and pass `worktree` param | Low |
| `components/GitDiffView.tsx` | Accept and pass `worktree` param | Low |
| `components/ChatSession.tsx` | Pass worktree to WebSocket URL | Low |
| `api.ts` | Add `worktree` param to all VM Agent calls | Low |
| `packages/terminal/` | Accept worktree for new session creation | Low-Medium |

### Layer 3: Control Plane API (Optional, for persistence)

The control plane doesn't strictly need to know about worktrees — they're a VM-level concern. But for better UX:

#### Agent session metadata

The `agent_sessions` table could store the worktree path:

```sql
ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;
```

This lets the UI restore the worktree association when reloading the page.

#### Workspace metadata (optional)

The control plane could cache the worktree list so the UI can show it immediately without waiting for a VM Agent call. But this is optimization, not required.

---

## Complexity Assessment

| Layer | Effort | Risk |
|-------|--------|------|
| VM Agent: worktree CRUD endpoints | 1-2 days | Low — straightforward `docker exec git worktree` |
| VM Agent: worktree param on existing endpoints | 1 day | Low — plumbing a validated path through |
| VM Agent: PTY worktree support | 0.5 days | Low — just a CWD override |
| VM Agent: ACP worktree support | 0.5 days | Low — just pass different Cwd |
| Frontend: WorktreeSelector component | 1-2 days | Medium — UX design decisions |
| Frontend: propagate worktree through all components | 1 day | Low — mechanical prop threading |
| Frontend: terminal worktree labeling | 1 day | Medium — multi-terminal protocol changes |
| Frontend: chat session worktree binding | 0.5 days | Low |
| Testing | 2-3 days | Medium — many interaction paths |
| **Total** | **~8-12 days** | **Medium overall** |

---

## Edge Cases and Gotchas

### 1. Shared .git directory
All worktrees share the same `.git` object store. This means:
- `git stash` in one worktree is visible in all worktrees
- Refs (branches, tags) are shared
- Worktrees can't check out the same branch simultaneously
- `git gc` and `git prune` affect all worktrees

### 2. Host clone path vs container runtime path
The current setup clones repos on the host under a workspace-ID path (for example `/workspace/WS_ABC123`) and runs the devcontainer from a named volume mounted at `/workspaces`.

Worktrees should be managed from inside the container runtime path (for example `/workspaces/my-repo*`) so all operations target the active runtime filesystem. Host clone directories are primarily provisioning inputs and are not the authoritative runtime context.

### 3. Branch checkout conflicts
You can't have the same branch checked out in two worktrees. The UI should:
- Show which branches are already checked out (and in which worktree)
- Disable selecting an already-checked-out branch when creating a new worktree
- Show a clear error if the user tries

### 4. Dirty worktree removal
`git worktree remove` fails if there are uncommitted changes. The UI should:
- Check for dirty state before showing the remove option
- Show a confirmation with the dirty file count
- Offer a force-remove option (with warning)

### 5. Agent session CWD is set at creation time
Claude Code's CWD is set in the ACP `NewSession` call and can't be changed mid-session. This means:
- Switching worktrees doesn't affect existing chat sessions (correct behavior)
- Each chat session is permanently bound to its creation-time worktree
- The UI must make this clear (worktree badge on chat tabs)

### 6. Worktree paths and security
The `worktree` parameter must be validated server-side:
- Must appear in `git worktree list` output
- Must be under the expected base directory
- Must not contain `..` or other traversal patterns
- Validation should be cached (worktree list doesn't change often)

---

## Alternative: Branch Switching Without Worktrees

A simpler alternative would be just making branch switching easier:
- Add a branch picker that runs `git checkout <branch>` in the terminal
- All terminals and agents would see the new branch
- No parallel work on multiple branches

**Why worktrees are better:**
- Developers frequently need to compare behavior across branches
- You can run tests on `main` while developing on `feature-x`
- Claude can work on one branch while you review another
- No need to stash/commit before switching — worktrees are independent
- Git worktrees are what power tools like VS Code's multi-root workspaces

---

## Implementation Order (Recommended)

### Phase 1: Backend Foundation
1. Worktree CRUD endpoints on VM Agent
2. Worktree path validation helper
3. `worktree` query param support on git/files endpoints

### Phase 2: Basic Frontend
4. WorktreeSelector component
5. Propagate worktree to file browser and git viewer
6. Worktree-aware API client functions

### Phase 3: Terminal Integration
7. Worktree CWD for new terminal sessions
8. Worktree badge on terminal tabs

### Phase 4: Agent Integration
9. Worktree-scoped agent session creation
10. Worktree badge on chat tabs
11. Agent session worktree metadata persistence

### Phase 5: Polish
12. Branch picker for worktree creation (with existing branch detection)
13. Dirty-state warnings on worktree removal
14. Devcontainer mount adjustment for multi-worktree access
15. Keyboard shortcut for worktree switching
