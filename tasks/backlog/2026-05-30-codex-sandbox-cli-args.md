# Fix Codex Bubblewrap Sandbox via CLI Args

## Problem

Codex agents running in SAM workspaces fail with bubblewrap sandbox errors:
```
apply_patch verification failed: Failed to read file to update .do-state.md:
fs sandbox helper failed with status exit status: 1:
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

PR #1149 attempted to fix this by writing `sandbox_mode = "danger-full-access"` to the user-level config (`~/.codex/config.toml`). However, Codex's config hierarchy is:

1. CLI flags (highest priority)
2. Project config (`.codex/config.toml` in repo)
3. User config (`~/.codex/config.toml`)

The SAM repo has a project-level `.codex/config.toml` that takes precedence over the user config. Since the project config doesn't set `sandbox_mode`, Codex uses its default (bubblewrap sandbox), which fails inside containers lacking `CAP_NET_ADMIN`.

## Solution

Pass `--sandbox danger-full-access` as CLI arguments to `codex-acp`. CLI flags have the highest priority and override all config files, making this work consistently for all SAM users regardless of their repo's `.codex/config.toml`.

## Research Findings

- Codex docs confirm CLI flags > project config > user config precedence
- Docker's own Codex docs use `--dangerously-bypass-approvals-and-sandbox` for containers
- `codex-acp` passes through all CLI args to the underlying binary
- `--sandbox danger-full-access` is more surgical than `--yolo` (only disables sandbox, not approvals)

## Checklist

- [ ] Add `--sandbox` and `danger-full-access` to args in `getAgentCommandInfo()` for both openai-codex credential paths
- [ ] Update existing tests to expect the new args
- [ ] Run `go test ./...` from `packages/vm-agent`
- [ ] Verify config.toml generation still includes sandbox_mode as belt-and-suspenders

## Acceptance Criteria

- [ ] `getAgentCommandInfo("openai-codex", "oauth-token")` returns args containing `--sandbox danger-full-access`
- [ ] `getAgentCommandInfo("openai-codex", "api-key")` returns args containing `--sandbox danger-full-access`
- [ ] All existing vm-agent tests pass
- [ ] No other agent types are affected
