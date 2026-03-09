# VM Agent Crash: Nil Pointer in BootLogBroadcaster + ACP Install Failure

**Status:** backlog
**Priority:** high
**Created:** 2026-02-24

## Problem Statement

The VM Agent is crash-looping on startup when a user initiates a chat session. Two distinct issues cause a cascading failure:

1. **ACP agent install fails** due to npm `ENOTEMPTY` errors when installing `@zed-industries/claude-code-acp` globally.
2. **Nil pointer dereference** in `BootLogBroadcaster.Broadcast()` crashes the process when the agent tries to report the install failure.

The agent service restarted at least 4 times during the observed window (~2 minutes), each time hitting the same crash sequence.

## Root Cause Analysis (Preliminary)

### Issue 1: Nil BootLogBroadcaster receiver

The stack trace shows:

```
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x950f06]

goroutine 317 [running]:
github.com/workspace/vm-agent/internal/server.(*BootLogBroadcaster).Broadcast(0x0, ...)
  /packages/vm-agent/internal/server/bootlog_ws.go:57 +0x186
github.com/workspace/vm-agent/internal/bootlog.(*Reporter).Log(...)
  /packages/vm-agent/internal/bootlog/reporter.go:82 +0xa5
github.com/workspace/vm-agent/internal/acp.(*SessionHost).reportAgentError(...)
  /packages/vm-agent/internal/acp/session_host.go:1518 +0x197
github.com/workspace/vm-agent/internal/acp.(*SessionHost).SelectAgent(...)
  /packages/vm-agent/internal/acp/session_host.go:392 +0xf93
created by github.com/workspace/vm-agent/internal/acp.(*Gateway).handleMessage
  /packages/vm-agent/internal/acp/gateway.go:291 +0x205
```

The receiver `0x0` on `(*BootLogBroadcaster).Broadcast` indicates the broadcaster pointer is nil. This means `reportAgentError` -> `Reporter.Log` -> `Broadcast` is called with a nil broadcaster reference. The broadcaster is likely not initialized before sessions can be created, or the reference wasn't properly wired during construction.

**Key files to investigate:**
- `packages/vm-agent/internal/server/bootlog_ws.go:57` — nil check needed on receiver
- `packages/vm-agent/internal/bootlog/reporter.go:82` — nil check on broadcaster before calling Broadcast
- `packages/vm-agent/internal/acp/session_host.go:1518` — where reportAgentError calls Reporter.Log
- `packages/vm-agent/internal/acp/gateway.go:291` — where the session is created (check broadcaster wiring)

### Issue 2: ACP agent npm install ENOTEMPTY

The `claude-code-acp` npm global install consistently fails with `ENOTEMPTY` errors:

```
npm error code ENOTEMPTY
npm error syscall rename
npm error path /usr/local/share/nvm/versions/node/v22.22.0/lib/node_modules/@zed-industries/claude-code-acp
npm error dest /usr/local/share/nvm/versions/node/v22.22.0/lib/node_modules/@zed-industries/.claude-code-acp-bzYRonWc
npm error errno -39
npm error ENOTEMPTY: directory not empty, rename '...' -> '...'
```

On at least one attempt, a prior failed install left behind partial directories, causing subsequent installs to also fail with `ENOENT` after cleanup failures:

```
npm error code ENOENT
npm error syscall mkdir
npm error path /usr/local/share/nvm/versions/node/v22.22.0/lib/node_modules/@zed-industries/claude-code-acp
npm error errno -2
npm error enoent ENOENT: no such file or directory, mkdir '...'
```

This suggests a race condition: two concurrent `SelectAgent` calls both detect the binary is missing and both attempt `npm install -g` simultaneously, corrupting the install directory.

**Evidence of race:** The logs show two nearly-simultaneous "Agent binary not found" messages before each crash:
```
14:43:52 "Agent binary not found in container, installing","command":"claude-code-acp"
14:43:52 "Agent binary not found in container, installing","command":"claude-code-acp"
```

**Key files to investigate:**
- `packages/vm-agent/internal/acp/session_host.go` — the `SelectAgent` method and its install logic
- Agent install function — needs a mutex or file lock to prevent concurrent installs

## Crash Timeline (from logs)

```
14:43:51  SessionHost created, viewer attached
14:43:51  Agent selection requested (x2 — possible race)
14:43:52  Agent binary not found (x2 — concurrent detection)
14:43:55  First install succeeds, second fails with ENOTEMPTY/ENOENT
14:43:55  reportAgentError -> Broadcast on nil BootLogBroadcaster -> SIGSEGV
14:43:55  vm-agent exits status=2, restart counter=2

14:44:00  Restart #3
14:44:18  New session, same pattern
14:44:19  Agent binary not found (x2)
14:44:20  Install fails ENOTEMPTY -> nil pointer crash
14:44:20  Restart counter=3

14:44:25  Restart #4
14:46:11  New session, same pattern
14:46:12  Agent binary not found (x2)
14:46:13  Install fails ENOTEMPTY -> nil pointer crash
14:46:13  Restart counter=4

14:46:18  Restart #5 — appears stable (no session request in window)
```

## Raw Logs

<details>
<summary>Full logs (chronological, earliest first)</summary>

```
15:43:51 INF SessionHost created, workspace=01KJ8130NW1RMYYW2HQY65DNXB, sessionId=01KJ81JTRMWJZ8Q3C2JCN2J03S
15:43:51 INF SessionHost: viewer attached, sessionID=01KJ81JTRMWJZ8Q3C2JCN2J03S, viewerID=viewer-ed7b511131a51f5d, totalViewers=1
15:43:51 INF SessionHost: agent selection requested, sessionID=01KJ81JTRMWJZ8Q3C2JCN2J03S, agentType=claude-code
15:43:51 INF SessionHost: agent selection requested, sessionID=01KJ81JTRMWJZ8Q3C2JCN2J03S, agentType=claude-code
15:43:52 INF Agent binary not found in container, installing, command=claude-code-acp
15:43:52 INF Agent binary not found in container, installing, command=claude-code-acp
15:43:55 INF Agent binary installed successfully, command=claude-code-acp
15:43:55 ERR Agent install failed, error="install command failed: exit status 254: npm warn cleanup Failed to remove some directories [...ENOTEMPTY...]"
15:43:55 PANIC runtime error: invalid memory address or nil pointer dereference
         server.(*BootLogBroadcaster).Broadcast(0x0, ...) bootlog_ws.go:57
         bootlog.(*Reporter).Log(...) reporter.go:82
         acp.(*SessionHost).reportAgentError(...) session_host.go:1518
         acp.(*SessionHost).SelectAgent(...) session_host.go:392
15:43:55 WRN vm-agent.service: Failed with result 'exit-code', status=2/INVALIDARGUMENT

15:44:00 INF Starting VM Agent (restart #3)
15:44:18 INF SessionHost created, workspace=01KJ8130NW1RMYYW2HQY65DNXB, sessionId=01KJ81Q9MQHHXBPAMC79QK9FMM
15:44:18 INF SessionHost: agent selection requested (x2)
15:44:19 INF Agent binary not found in container, installing (x2)
15:44:20 ERR Agent install failed, error="ENOTEMPTY: directory not empty, rename ..."
15:44:20 PANIC runtime error: invalid memory address or nil pointer dereference (same stack trace)
15:44:20 WRN vm-agent.service: Failed (restart counter=3)

15:44:25 INF Starting VM Agent (restart #4)
15:46:11 INF SessionHost created, sessionId=01KJ81TR9BA03DGGCPH899S560
15:46:11 INF SessionHost: agent selection requested (x2)
15:46:12 INF Agent binary not found in container, installing (x2)
15:46:13 ERR Agent install failed, error="ENOTEMPTY..."
15:46:13 PANIC nil pointer dereference (same stack trace)
15:46:13 WRN vm-agent.service: Failed (restart counter=4)

15:46:18 INF Starting VM Agent (restart #5, no immediate crash observed)
```

</details>

## Checklist

- [ ] **Investigate nil broadcaster**: Check how `BootLogBroadcaster` is wired into `Reporter` and `SessionHost`; add nil guard
- [ ] **Add nil check in Broadcast**: `bootlog_ws.go:57` should be safe to call on nil receiver
- [ ] **Add nil check in Reporter.Log**: `reporter.go:82` should guard against nil broadcaster
- [ ] **Fix concurrent install race**: Add mutex/lock around ACP agent install in `SelectAgent`
- [ ] **Clean up stale install dirs**: Before installing, remove any leftover partial install directories
- [ ] **Deduplicate agent selection**: Investigate why `agent selection requested` fires twice per session
- [ ] **Add tests** for nil broadcaster and concurrent install scenarios

## Related

- Node: `01KJ81309BV0XT6K10T9KJXMJM`
- Workspace: `01KJ8130NW1RMYYW2HQY65DNXB`
- Affected sessions: `01KJ81JTRMWJZ8Q3C2JCN2J03S`, `01KJ81Q9MQHHXBPAMC79QK9FMM`, `01KJ81TR9BA03DGGCPH899S560`
