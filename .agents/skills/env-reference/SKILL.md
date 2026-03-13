---
name: env-reference
description: "Full environment variable reference for SAM. Use when adding, modifying, or documenting environment variables, configuring deployment, or working with Worker secrets. Trigger when asked about env vars, secrets, or configuration."
---

# SAM Environment Variable Reference

Read the full reference from `.claude/skills/env-reference/SKILL.md` and provide the relevant information to the user.

The reference covers:
- GitHub Environment Secrets (`GH_*` prefix)
- GH_ to GITHUB_ mapping (done by `configure-secrets.sh`)
- API Worker Runtime Environment Variables:
  - Core settings
  - Resource limits (MAX_NODES_PER_USER, MAX_AGENT_SESSIONS_PER_WORKSPACE, etc.)
  - Pagination settings
  - Timeouts (heartbeat, Hetzner API, Cloudflare API, Node Agent)
  - Audio/Transcription settings
  - Client error reporting settings
- VM Agent Environment Variables:
  - Container/User settings
  - Git operations (timeouts, worktree limits)
  - File operations (timeouts, max entries)
  - Error reporting (flush interval, batch size)
  - ACP settings (buffer sizes, ping/pong, prompt timeout, idle suspend)
  - Events (max retained)
  - System info (Docker timeout, cache TTL)

Also see `apps/api/.env.example` for the full list.
