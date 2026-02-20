---
name: changelog
description: Recent feature changes and implementation details for SAM. Use when understanding recent changes, checking what was modified recently, or understanding feature history.
user-invocable: false
---

# SAM Recent Changes

For the latest changes, also check `git log --oneline -20`.

- **session-visibility**: VM Agent enriches session responses with live `hostStatus` and `viewerCount`; shared `AgentHostStatus` type; new `listAgentSessionsLive()` browser API; enhanced status colors in workspace UI
- **devcontainer-runtime-user-consistency**: VM Agent resolves effective devcontainer execution user when `CONTAINER_USER` is unset; detection order: `devcontainer read-configuration` > `devcontainer.metadata` label > `docker exec id -un` fallback; per-workspace `ContainerUser` stored in runtime
- **workspace-runtime-identity**: VM Agent derives host workspace identity from canonical `workspaceId`; strict workspace label matching prevents cross-workspace routing
- **sam-workspace-env**: SAM platform metadata injected as env vars into devcontainers during bootstrap (`SAM_WORKSPACE_ID`, `SAM_NODE_ID`, `SAM_WORKSPACE_URL`, `SAM_API_URL`, `SAM_REPOSITORY`, `SAM_BRANCH`)
- **worktree-context**: Deep git worktree integration across VM agent, API, shared types, terminal, and workspace UI; worktree-aware terminal/chat session creation; `WorktreeSelector` UI
- **node-system-info**: VM Agent sysinfo package collects metrics from Linux procfs and Docker CLI; two-tier collection (quick for heartbeat, full for `/system-info` endpoint); Node detail page redesigned with composed section components
- **devcontainer-named-volumes**: Replaced bind-mount storage with named Docker volumes (`sam-ws-<workspaceId>`); eliminated permission normalization
- **command-palette-search**: Enhanced command palette with fuzzy file search and tab switching; camelCase-aware fuzzy matching
- **tab-reorder-rename**: Unified tab ordering, rename, and drag-and-drop reordering; useTabOrder hook with localStorage persistence
- **persistent-agent-sessions**: Agent processes survive browser disconnects; SessionHost owns agent lifecycle independently; fan-out message broadcasting; bounded message ring buffer for late-join replay
- **workspace-keyboard-shortcuts**: VS Code-style keyboard shortcuts; centralized shortcut registry with platform-aware matching
- **agent-settings-acp-protocol**: Wire agent settings through ACP protocol; all 5 permission modes exposed
- **comprehensive-lifecycle-logging**: End-to-end ACP/WebSocket lifecycle observability via CF Workers
- **vm-agent-error-reporting**: Go errorreport package with batching and periodic flushing
- **client-error-reporting**: Client-side error reporting pipeline with batched sends
- **agent-file-ops**: ACP ReadTextFile and WriteTextFile handlers via docker exec
- **file-browser**: File browser with directory listing and syntax-highlighted file viewer
- **git-changes-viewer**: GitHub PR-style git changes viewer with unified diff
- **voice-to-text**: Voice input with Workers AI Whisper transcription
- **014-multi-workspace-nodes**: First-class Nodes with multi-workspace hosting, async provisioning, workspace recovery
- **013-agent-oauth-support**: Dual credential support for Claude Code (API key + OAuth token)
- **012-pty-session-persistence**: PTY sessions survive page refresh with ring buffer replay
