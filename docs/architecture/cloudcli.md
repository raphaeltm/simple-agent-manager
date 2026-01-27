# CloudCLI - DEPRECATED

> **Status: DEPRECATED** - We are no longer using CloudCLI. See [Browser Terminal Architecture](../../research/browser-terminal-options.md) for the replacement approach.

## Why We Moved Away

CloudCLI (claude-code-ui) proved unstable and overly complex for our needs. We've replaced it with a simpler architecture using **ttyd** - a lightweight terminal server that provides browser-based terminal access directly into devcontainers.

## New Architecture

```
Browser ──HTTPS──► Cloudflare ──HTTP──► VM:7681 ──► devcontainer
        (xterm.js)   (proxy)           (ttyd)      (Claude Code CLI)
```

Key benefits of the new approach:
- Battle-tested components (ttyd, xterm.js)
- Simpler architecture with fewer moving parts
- Terminal runs on host, executes into container via `devcontainer exec`
- No custom UI to maintain

## Historical Reference

CloudCLI was:
- Package: `@siteboon/claude-code-ui`
- Port: 3001
- GitHub: https://github.com/siteboon/claudecodeui

This information is preserved for historical context only. Do not use CloudCLI for new development.
