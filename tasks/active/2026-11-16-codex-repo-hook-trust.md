# SAM Codex sessions run repository hooks (trust them), plus Codex rule delivery and Stop gate

Raphaël, 2026-11-16 (chat b0530f70, after PR #2790): "if the hooks are defined in the repo (i.e. the user or their agent set them up... then I think they should" -> "Yup. Do it." Idea 01M7J0TXAHGRY8CWA7Y7SJZAK0.

## Problem
Codex runs a non-managed hook only when its definition is trusted by hash (an interactive `/hooks` review). codex-acp already trusts the session roots as projects, so the repository's `.codex/` layer loads, but the vm-agent never supplied hook trust, so no repository hook runs in a SAM Codex session (probe 01M7HZ6Q1EVPVPCBN00AM3WN8A). Claude Code sessions already run `.claude/settings.json` hooks.

## Research
- Codex rust-v0.160.0 (SAM pins 0.160.0-sam-c2.2): `codex-rs/app-server/src/config_manager.rs` accepts a per-thread request override `bypass_hook_trust` (bool), which `codex-rs/hooks/src/engine/discovery.rs` uses to run non-managed hooks without a trust hash. codex-acp 2.1.1 `dist/index.js` already sets `projects.<session root>.trust_level = "trusted"`.
- codex-acp forwards `CODEX_CONFIG` JSON to every app-server thread (`buildCodexACPManagedConfigEnv`, now in `packages/vm-agent/internal/acp/session_host_agent_config.go`). ACP session cwd = `h.config.ContainerWorkDir` (`session_host_handshake.go`), same SessionHost path for VM and Instant.
- Hook code ready on branch `sam/codex-rule-delivery-hook` (f3b156c19).

## Checklist
- [x] vm-agent: CODEX_CONFIG carries `bypass_hook_trust: true` (codex-acp already trusts the session roots); tests
- [x] Restore `.codex/hooks/rule-context.mjs`, generated `rule-scopes.json` + `--check` staleness, Codex hook entries (SessionStart, PreToolUse, Stop), `.gitignore` re-include
- [x] Close Codex-hook test gaps from the PR #2790 test review (deny-once with deferred rules, cd/cwd, ignored dirs, write table, patch ops, SessionStart sources, session isolation, config wiring, real-lookup smoke)
- [x] Docs: scripts/quality/README.md, security doc if it describes hook/trust behaviour
- [ ] Staging: deploy, fresh VM node, Codex session on a repo with the hooks: rule text before the first edit (existing file, new file, shell), Stop gate fires; control without hooks
- [ ] Reviews, CI, merge, deploy monitoring

## Acceptance
- [ ] A SAM Codex session on staging runs the repository hooks (log + agent report), Stop gate continues the turn once
- [ ] Unit tests prove CODEX_CONFIG content for VM and standalone shapes

## Progress (state survives workspace restores here, not in .tmp)
- Commits: 413910d14 restore hook+tests, 2d13120a4 pure move, 94f9c1179 CODEX_CONFIG trust, b9a3745e9 docs, c589cedf3 seed script. Draft PR #2804.
- Staging: only `staging` (sammy.party) has Codex creds (smoke user toWzGjNW3IyUkCVItRQv3qSn0wI8c22y, auth-json); staging2 has none. Lease held by sam/build-insights-slice-f-2z1gpd until 15:30Z.
- Staging plan: deploy branch (no nodes running at 15:02Z); as smoke user create Artifacts project; task A (claude-code) runs `scripts/diagnostics/seed-codex-hook-probe.sh <sha>` and pushes to main; task B (openai-codex) probes rule delivery + Stop gate. Helper: .tmp/staging/api.sh (recreate if lost).
- Reviewers running: security-auditor, go-specialist.
- 15:20Z: codex-acp 2.1.1 already trusts the session roots as projects (dist/index.js `projects: Object.fromEntries(sessionRoots...)`), so the earlier "project untrusted" diagnosis was wrong: only hook trust was missing. CODEX_CONFIG now adds only `bypass_hook_trust: true` (adf4108df).
- Local real-process proof: `TestCodexRunsRepositoryHooksWithSAMConfig` with stock codex-cli 0.160.0 + codex-acp 2.1.1 (npm into .tmp/codexpkgs): SessionStart context in request 1; rule canary delivered as a developer message between the read call and its output; write `printf > src/new.txt` refused once with the rule attached, file not created; Stop gate continuation in request 3. Control (old CODEX_CONFIG): none. Mutation bypass=false -> both trusted cases red.
- Reviews: security-auditor (no CRIT; HIGH inherent; docs scope fixed; MCP redirect deferred: needs no new capability and project layer already loaded before this PR), go-specialist (no CRIT/HIGH; addressed).
- Staging lease: `staging` held by sam/implement-slice-d-inbox-vhkf2w until 17:04Z; staging2 has no Codex credentials. Wake scheduled ~17:05Z.
