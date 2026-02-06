# CloudCLI - REMOVED

> **Status: REMOVED** - CloudCLI has been fully removed from the codebase.

## Why It Was Removed

CloudCLI (`@siteboon/claude-code-ui`) was a third-party terminal UI that proved unstable and overly complex. It has been replaced by:

1. **VM Agent's embedded terminal UI** - A lightweight xterm.js frontend served by the Go VM Agent
2. **Control plane embedded terminal** - The `@simple-agent-manager/terminal` package used in the web dashboard

## Current Architecture

```
Browser ──WebSocket──► VM Agent (port 8080) ──docker exec──► devcontainer
        (xterm.js)         (Go, PTY mgmt)                    (default user)
```

All terminal sessions exec into the devcontainer as the configured user (default: `vscode`), ensuring commands run in the correct environment with the right tools installed.
