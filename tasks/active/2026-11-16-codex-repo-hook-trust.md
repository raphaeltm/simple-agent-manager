# SAM Codex sessions run repository hooks (trust them), plus Codex rule delivery and Stop gate

Raphaël, 2026-11-16 (chat b0530f70, after PR #2790): "if the hooks are defined in the repo (i.e. the user or their agent set them up... then I think they should" -> "Yup. Do it." Idea 01M7J0TXAHGRY8CWA7Y7SJZAK0.

## Problem
Codex loads a repository's `.codex/` layer only for a trusted project and runs a non-managed hook only when its definition is trusted by hash. The vm-agent marks neither, so no repository hook runs in a SAM Codex session (probe 01M7HZ6Q1EVPVPCBN00AM3WN8A). Claude Code sessions already run `.claude/settings.json` hooks.

## Research
- Codex rust-v0.160.0 (SAM pins 0.160.0-sam-c2.2): `codex-rs/app-server/src/config_manager.rs` accepts a per-thread request override `bypass_hook_trust` (bool); `codex-rs/config/src/loader/mod.rs` reads `projects.<dir>.trust_level` from the merged config including CLI/request overrides, and `decision_for_dir` checks cwd, project root and repo root.
- codex-acp forwards `CODEX_CONFIG` JSON to every app-server thread (`packages/vm-agent/internal/acp/session_host_startup.go`, `buildCodexACPManagedConfigEnv`). ACP session cwd = `h.config.ContainerWorkDir` (`session_host_handshake.go`), same SessionHost path for VM and Instant.
- Hook code ready on branch `sam/codex-rule-delivery-hook` (f3b156c19).

## Checklist
- [ ] vm-agent: CODEX_CONFIG carries `bypass_hook_trust: true` and `projects.<workdir>.trust_level = "trusted"`; tests
- [ ] Restore `.codex/hooks/rule-context.mjs`, generated `rule-scopes.json` + `--check` staleness, Codex hook entries (SessionStart, PreToolUse, Stop), `.gitignore` re-include
- [ ] Close Codex-hook test gaps from the PR #2790 test review (deny-once with deferred rules, cd/cwd, ignored dirs, write table, patch ops, SessionStart sources, session isolation, config wiring, real-lookup smoke)
- [ ] Docs: scripts/quality/README.md, security doc if it describes hook/trust behaviour
- [ ] Staging: deploy, fresh VM node, Codex session on a repo with the hooks: rule text before the first edit (existing file, new file, shell), Stop gate fires; control without hooks
- [ ] Reviews, CI, merge, deploy monitoring

## Acceptance
- [ ] A SAM Codex session on staging runs the repository hooks (log + agent report), Stop gate continues the turn once
- [ ] Unit tests prove CODEX_CONFIG content for VM and standalone shapes
