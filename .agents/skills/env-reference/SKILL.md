---
name: env-reference
description: 'Full environment variable reference for SAM. Use when adding, modifying, or documenting environment variables, configuring deployment, or working with Worker secrets. Trigger when asked about env vars, secrets, or configuration.'
---

# SAM Environment Variable Reference

Read the full reference from `.claude/skills/env-reference/SKILL.md` and provide the relevant information to the user.

The reference covers:

- GitHub Environment Secrets (`GH_*` prefix)
- `GH_*` to `GITHUB_*` mapping (done by `configure-secrets.sh`)
- API Worker Runtime Environment Variables:
  - Core settings
  - Cloudflare Container instant-session runtime flags
  - Resource limits (MAX_NODES_PER_USER, MAX_AGENT_SESSIONS_PER_WORKSPACE, etc.)
  - Pagination settings
  - Timeouts and retry controls (TaskRunner readiness/provisioning, heartbeat, Hetzner API/capacity retry, Cloudflare API, Node Agent)
  - Provider runtime tuning (including Hetzner list-page bounds)
  - VM agent rollout requirement (`VM_AGENT_REQUIRED_VERSION`)
  - Audio/Transcription settings
  - Client error reporting settings
  - Generic webhook trigger limits, rate damping, and audit retention
  - ProjectData event-subscription limits, bounded metadata/display payload caps, and retention
  - Platform feedback, private incident backlog, and Report-an-Issue settings
- VM Agent Environment Variables:
  - Container/User settings
  - Git operations (timeouts, worktree limits)
  - File operations (timeouts, max entries)
  - Error reporting (flush interval, batch size)
  - ACP settings (buffer sizes, ping/pong, prompt timeout, prompt retries, idle suspend)
  - Events (max retained)
  - System info (Docker timeout, cache TTL)

Also see `apps/api/.env.example` for the full list.
