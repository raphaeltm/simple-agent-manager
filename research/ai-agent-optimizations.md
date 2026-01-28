# AI Coding Agent UX Optimizations

> **Related docs:** [Architecture Notes](./architecture-notes.md) | [DNS & Security](./dns-security-persistence-plan.md) | [Multi-tenancy](./multi-tenancy-interfaces.md) | [Index](./README.md)

## The Problem

The current architecture reads like a generic devcontainer orchestration system. But the PRIMARY use case is running AI coding agents (Claude Code, Aider, etc.). This document outlines optimizations to make the platform purpose-built for AI agent workflows.

## Positioning Shift

**Before:** "Serverless Dev Container Manager"
**After:** "Simple Agent Manager" or "Remote Claude Code Environments"

The platform should feel like "GitHub Codespaces, but optimized for AI coding agents."

---

## Key Optimizations for MVP

### 1. Claude Code Pre-Installation

Use Anthropic's official devcontainer feature instead of manual npm install.

**Default devcontainer.json:**
```json
{
  "name": "Claude Code Workspace",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {}
  },
  "mounts": [
    "source=claude-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude,type=volume"
  ],
  "containerEnv": {
    "CLAUDE_CONFIG_DIR": "/home/vscode/.claude"
  },
  "postCreateCommand": "claude --version",
  "remoteUser": "vscode"
}
```

**References:**
- [Anthropic DevContainer Features](https://github.com/anthropics/devcontainer-features)
- [Claude Code DevContainer Docs](https://code.claude.com/docs/en/devcontainer)

---

### 2. First-Class API Key Management

The control plane UI should have a dedicated field for `ANTHROPIC_API_KEY` (and future keys).

**Flow:**
1. User enters API key in control plane UI (one-time setup or per-workspace)
2. Key encrypted and stored (per-tenant in future)
3. Key injected via cloud-init as environment variable
4. Devcontainer inherits the key from host environment
5. Key NEVER stored in devcontainer.json (that goes in git)

**Cloud-init injection:**
```bash
# Set API key before starting devcontainer
export ANTHROPIC_API_KEY="${INJECTED_API_KEY}"

# Start devcontainer with env passthrough
devcontainer up --workspace-folder /workspace
```

**UI Design:**
```
┌─────────────────────────────────────────────┐
│  Create New Workspace                        │
├─────────────────────────────────────────────┤
│  Repository URL: [________________________] │
│                                              │
│  API Keys (stored securely):                 │
│  ANTHROPIC_API_KEY: [********************]  │
│  OPENAI_API_KEY:    [____________________]  │ (optional)
│                                              │
│  [ ] Remember keys for future workspaces     │
│                                              │
│  [Create Workspace]                          │
└─────────────────────────────────────────────┘
```

**Security Best Practices:**
- Never hardcode in config files
- Encrypt at rest (AES-256)
- Principle of least privilege
- Support for key rotation
- Audit logging of key access

**References:**
- [OpenAI API Key Safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)

---

### 3. Claude Config Directory Persistence

The `~/.claude` directory contains critical data that must persist:
- Session history (for `claude --continue`)
- MCP server configurations
- User settings
- Custom commands

**Persistence Strategy:**
1. Mount `~/.claude` as named Docker volume during devcontainer runtime
2. On workspace backup (shutdown), include `~/.claude` in the tarball
3. On workspace restore (startup), extract `~/.claude` before devcontainer starts

**What's in `~/.claude`:**
```
~/.claude/
├── settings.json          # User preferences
├── settings.local.json    # Local overrides
├── sessions/              # Conversation history
│   └── <session-id>.json
├── commands/              # Custom slash commands
│   └── my-command.md
└── mcp/                   # MCP server state
```

**Environment Variable:**
```bash
export CLAUDE_CONFIG_DIR="/home/vscode/.claude"
```

This ensures Claude Code finds its config regardless of how the container is structured.

---

### 4. CLAUDE.md Auto-Generation

[CLAUDE.md is the single most impactful optimization](https://www.maxzilla.nl/blog/claude-code-environment-best-practices) - it provides project context that makes Claude exponentially more effective.

**Auto-generation logic (in cloud-init):**

```bash
#!/bin/bash
# Generate CLAUDE.md if it doesn't exist

if [ -f /workspace/CLAUDE.md ]; then
  echo "CLAUDE.md already exists, skipping generation"
  exit 0
fi

# Detect project type
PROJECT_TYPE="unknown"
PACKAGE_MANAGER=""
TEST_COMMAND=""
DEV_COMMAND=""

if [ -f /workspace/package.json ]; then
  PROJECT_TYPE="Node.js"
  if [ -f /workspace/yarn.lock ]; then
    PACKAGE_MANAGER="yarn"
  elif [ -f /workspace/pnpm-lock.yaml ]; then
    PACKAGE_MANAGER="pnpm"
  else
    PACKAGE_MANAGER="npm"
  fi
  TEST_COMMAND="${PACKAGE_MANAGER} test"
  DEV_COMMAND="${PACKAGE_MANAGER} run dev"
fi

if [ -f /workspace/requirements.txt ] || [ -f /workspace/pyproject.toml ]; then
  PROJECT_TYPE="Python"
  PACKAGE_MANAGER="pip"
  TEST_COMMAND="pytest"
  DEV_COMMAND="python main.py"
fi

if [ -f /workspace/Cargo.toml ]; then
  PROJECT_TYPE="Rust"
  PACKAGE_MANAGER="cargo"
  TEST_COMMAND="cargo test"
  DEV_COMMAND="cargo run"
fi

if [ -f /workspace/go.mod ]; then
  PROJECT_TYPE="Go"
  PACKAGE_MANAGER="go"
  TEST_COMMAND="go test ./..."
  DEV_COMMAND="go run ."
fi

# Generate CLAUDE.md
cat > /workspace/CLAUDE.md << EOF
# Project Context for Claude

## Overview
<!-- Describe your project here -->
This is a ${PROJECT_TYPE} project.

## Tech Stack
- Language: ${PROJECT_TYPE}
- Package Manager: ${PACKAGE_MANAGER}

## Common Commands
\`\`\`bash
# Install dependencies
${PACKAGE_MANAGER} install

# Run tests
${TEST_COMMAND}

# Start development
${DEV_COMMAND}
\`\`\`

## Code Style
- Follow existing patterns in the codebase
- Use type annotations where applicable
- Write tests for new functionality

## Project Structure
<!-- Update this section with your project's structure -->
\`\`\`
/workspace
├── src/           # Source code
├── tests/         # Test files
└── README.md      # Project documentation
\`\`\`

## Important Notes
<!-- Add project-specific instructions for Claude here -->
-
EOF

echo "Generated CLAUDE.md for ${PROJECT_TYPE} project"
```

**User can customize** via CloudCLI's file explorer - changes persist with workspace.

---

### 5. Pre-Configured MCP Servers

[MCP servers transform Claude from assistant to development hub](https://www.maxzilla.nl/blog/claude-code-environment-best-practices).

**Recommended default MCP servers:**

| Server | Purpose | Pre-install? |
|--------|---------|-------------|
| **context7** | Documentation lookup | Yes |
| **sequential-thinking** | Step-by-step reasoning | Yes |
| **filesystem** | File operations | Built-in |
| **github** | GitHub integration | If token provided |

**Pre-configuration (in cloud-init):**
```bash
# Configure MCP servers
mkdir -p /workspace/.claude

cat > /workspace/.mcp.json << 'EOF'
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-context7"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-sequential-thinking"]
    }
  }
}
EOF
```

**Note:** Keep MCP server count low initially - [too many affects performance](https://www.maxzilla.nl/blog/claude-code-environment-best-practices).

---

### 6. Agent-Aware Idle Detection

Standard idle detection checks for file changes and SSH sessions. For AI agents, we need smarter heuristics.

**Enhanced idle check:**
```bash
#!/bin/bash
# /usr/local/bin/idle-check.sh
IDLE_MINUTES=30
WORKSPACE="/workspace"

is_idle() {
  # 1. Recent file changes in workspace
  recent_files=$(find "$WORKSPACE" -type f -mmin -$IDLE_MINUTES 2>/dev/null | head -1)

  # 2. Active Claude Code processes
  claude_procs=$(pgrep -f "claude|@anthropic-ai" | head -1)

  # 3. Active Node processes (CloudCLI, MCP servers)
  node_procs=$(pgrep -f "node.*claude\|cui-server\|claude-code-ui" | head -1)

  # 4. Web UI connections (CloudCLI)
  web_connections=$(ss -tnp 2>/dev/null | grep -c ":3001.*ESTAB" || echo 0)

  # 5. SSH sessions
  ssh_sessions=$(who | wc -l)

  # 6. Check for recent Claude API activity (if trackable)
  # This could check ~/.claude/sessions for recent modifications
  recent_sessions=$(find ~/.claude/sessions -type f -mmin -$IDLE_MINUTES 2>/dev/null | head -1)

  # Only idle if ALL conditions are false
  [ -z "$recent_files" ] && \
  [ -z "$claude_procs" ] && \
  [ -z "$node_procs" ] && \
  [ "$web_connections" -eq 0 ] && \
  [ "$ssh_sessions" -eq 0 ] && \
  [ -z "$recent_sessions" ]
}

if is_idle; then
  echo "$(date): Workspace idle, initiating shutdown" >> /var/log/idle-check.log
  # Backup workspace before shutdown
  /usr/local/bin/backup-workspace.sh
  # Self-destruct
  ${SELF_DELETE_COMMAND}
else
  echo "$(date): Workspace active" >> /var/log/idle-check.log
fi
```

**Key additions:**
- Check for Claude Code processes specifically
- Check CloudCLI/CUI Node processes
- Check for recent session file modifications
- Backup workspace before shutdown

---

### 7. Session Continuity

Users should be able to resume Claude conversations across VM restarts.

**How it works:**
1. `~/.claude/sessions/` contains conversation history
2. This directory is backed up to R2 with workspace
3. On workspace restore, sessions are available
4. User can run `claude --continue` or `claude --resume`

**CloudCLI integration:**
If using CloudCLI, session management may be built into the UI. Need to verify if it persists sessions or relies on Claude's native session files.

---

### 8. Optimized Default Devcontainer

The default devcontainer (when repo has none) should be AI-agent optimized:

```json
{
  "name": "Claude Code Workspace",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",

  "features": {
    // Core tools
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {},

    // Node.js for Claude Code and tools
    "ghcr.io/devcontainers/features/node:1": {
      "version": "22"
    },

    // Claude Code
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {},

    // Common languages (can be customized)
    "ghcr.io/devcontainers/features/python:1": {
      "version": "3.12"
    }
  },

  "mounts": [
    // Persist Claude config across container rebuilds
    "source=claude-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude,type=volume"
  ],

  "containerEnv": {
    "CLAUDE_CONFIG_DIR": "/home/vscode/.claude"
  },

  "postCreateCommand": "echo '✅ Claude Code workspace ready!' && claude --version",

  "customizations": {
    "vscode": {
      "extensions": [
        // Minimal extensions for Claude Code workflow
        "github.copilot",  // Optional, for comparison
        "streetsidesoftware.code-spell-checker"
      ]
    }
  },

  "remoteUser": "vscode"
}
```

---

## Summary: Generic vs AI-Optimized

| Aspect | Generic DevContainer | AI-Optimized Workspace |
|--------|---------------------|------------------------|
| **Primary Tool** | Any IDE/editor | Claude Code pre-installed |
| **API Keys** | User manages manually | First-class UI, secure injection |
| **Config Persistence** | None | `~/.claude` backed up to R2 |
| **Project Context** | None | CLAUDE.md auto-generated |
| **MCP Servers** | None | Context7, Sequential Thinking |
| **Idle Detection** | File changes only | Agent-aware (processes, sessions) |
| **Session Resume** | Not supported | `claude --continue` works |
| **UI** | Generic terminal | CloudCLI with file/git integration |

---

## Implementation Priority

### MVP Must-Have
1. ✅ Claude Code devcontainer feature
2. ✅ ANTHROPIC_API_KEY input in UI + secure injection
3. ✅ `~/.claude` persistence (volume mount + R2 backup)
4. ✅ Agent-aware idle detection

### MVP Should-Have
5. 🔶 CLAUDE.md auto-generation
6. 🔶 Pre-configured MCP servers (.mcp.json)
7. 🔶 `--dangerously-skip-permissions` flag for sandbox

### Phase 2
8. ⏳ Multi-agent support (Aider, OpenHands)
9. ⏳ Token usage tracking/display
10. ⏳ Custom MCP server configuration UI
11. ⏳ Project type detection for smarter defaults

---

## References

### Claude Code Configuration
- [Claude Code Best Practices (Anthropic)](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Complete Claude Code Setup Guide](https://www.maxzilla.nl/blog/claude-code-environment-best-practices)
- [Claude Code Context Management](https://medium.com/@kushalbanda/claude-code-context-management-if-youre-not-managing-context-you-re-losing-output-quality-71c2d0c0bc57)

### DevContainer Setup
- [Anthropic DevContainer Features](https://github.com/anthropics/devcontainer-features)
- [Running AI Agents in DevContainers](https://codewithandrea.com/articles/run-ai-agents-inside-devcontainer/)
- [Claude Code DevContainer Docs](https://code.claude.com/docs/en/devcontainer)

### Session Management
- [Claude Code Session Management](https://stevekinney.com/courses/ai-development/claude-code-session-management)
- [Context Persistence Issue](https://github.com/anthropics/claude-code/issues/2954)

### MCP Servers
- [Configuring MCP Tools](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)
- [MCP Server Setup Guide](https://mcpcat.io/guides/adding-an-mcp-server-to-claude-code/)
