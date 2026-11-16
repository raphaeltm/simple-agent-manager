# Agent tooling that enforces itself (stream A of the agent-context work)

SAM task 01M7HX013ZBS5KJAXB0H707DEJ. Plan, reviews and evidence: SAM idea 01M7H32EK6S4E31EHWVSJSENR5
(Sol notes 01M7H7X0BESSN1P0WX7NY06TP4, 01M7HA938BY8MXQY0PWQ754CBG) and idea 01M7H8SDG77AE0FH39QXW3NPYX (Stop gate).
Coordination channel: feature.agent-context. Authorization: Raphaël, chat 749fad59, 2026-11-16.

## Problem

Three pieces of agent tooling rely on agents choosing to comply:

1. Rule 73 (optional struct fields must not overwrite on absence) is 12 KB of launch context
   and has no automated check.
2. Codex sessions started at the repository root load only the root `AGENTS.md`; path-scoped
   rules reach Codex only if the agent opens them.
3. `.claude/hooks/verify-test-quality.sh` has never run (malformed Claude Code entry from
   2026-05-17 until #2778 removed it; the `.codex/config.toml` `[[hooks.Stop]]` entry has no
   `hooks` array, so it holds zero handlers under the current Codex schema). The script itself is
   unsafe to enable (Sol's probes).

Acceptance rule (Raphaël): nothing leaves always-loaded context unless it is certain to load in
the right context or is enforced programmatically. Guard first, removal second.

## Research findings

- Tooling from #2778: `scripts/quality/agent-instructions.ts` (single source of rule scopes),
  `agent-instruction-guards.ts`, `agent-hook-config.ts` (Claude hook validation only),
  `agent-instruction-observed.ts`, `check-agent-context-budget.ts`, `agent-context-budget.json`
  (`launchRules`), `.claude/hooks/log-instructions-loaded.sh`.
- Rule 73 incident shape: `packages/vm-agent/internal/server/workspace_routing.go`
  `upsertWorkspaceRuntime(..., opts ...workspaceRuntimeOpts)`; strings guarded, `Lightweight bool`
  copied unconditionally. Fixed by `*bool`. Stored-layer shape: `skills.agent_type NOT NULL DEFAULT`
  (migration 0063, fixed by 0200).
- Codex hooks (developers.openai.com/codex/hooks, fetched 2026-11-16): events nest
  event -> matcher group -> `hooks` handlers; `timeout` in seconds; project hooks load only when
  the project `.codex/` layer is trusted and each non-managed hook must be trusted by hash
  (`/hooks`, or `--dangerously-bypass-hook-trust`). SessionStart matcher = source
  (startup|resume|clear|compact|fork); PreToolUse matches Bash and apply_patch (alias Edit|Write),
  `tool_input.command` carries the command or patch. `additionalContext` spills to disk above
  ~2,500 tokens unless `additionalContextLimit` is raised. Stop expects JSON on stdout;
  `decision: "block"` continues the turn with `reason` as a new prompt.
- No Go toolchain or `codex` binary in this workspace; CI has Go 1.26.11 in Go jobs only.
  `repo-quality` CI filter covers `packages/**`, so Code Quality Checks runs on Go changes.
- `.codex/**` is not in the `agent-instructions` CI filter (Sol).

## Implementation checklist

### Part 1: rule 73 check
- [x] Go analyzer (go/ast) for options/patch structs whose non-string field is copied without a guard
- [x] Fixture tests: original incident shape fails, fixed shape passes, controls (guarded, string, explicit-false)
- [x] Measure hits on the current tree (vm-agent, cli, harness); decide advisory vs blocking per policy f9ae7f88
- [x] Wire into CI (Code Quality Checks) and a pnpm script
- [x] Decide and record: TypeScript counterpart feasibility (measured), SQL override-column shape
- [x] Launch decision for rule 73: blocking check + full path scope (Go, TS, TSX, SQL migrations, DO migrations) + fresh Claude probe (C1 01M7HYQHAH3787PH8A0TCV6296: absent at launch, loads with the first Write of a new .ts; C2 01M7HYQVK025M14GN4QG9G8WTF: loads on Read of a .sql before any edit; --observed matches both)
- [x] Record the procedure in `.claude/rules/00-rule-routing.md`

### Part 2: Codex rule delivery
- [x] Generated static rule-scope lookup written by `--write`, stale lookup fails `--check`
- [x] Dependency-free hook (no node_modules): SessionStart (startup/resume/compact) + PreToolUse (apply_patch, Bash) injects applicable rule bodies, bounded, with a log
- [x] Hook never blocks or crashes a session; tests drive the real script
- [x] `.codex/config.toml` entries valid per current schema; `agent-hook-config.ts` validates Codex entries
- [x] Codex probe (profile Sol) on the branch: round 1b 01M7HZ6Q1EVPVPCBN00AM3WN8A (script committed) shows no repository hook runs in SAM Codex sessions (project and hooks untrusted). Not good -> not shipped: hook preserved on branch sam/codex-rule-delivery-hook pending the trust decision
- [x] Add `.codex/**` to the CI agent-instructions filter

### Part 3: Stop gate
- [x] Rewrite: merge-base + committed + staged + untracked changes; package-aware boundary paths incl. `packages/project-data/src/do`; source-only (no docs); no `stop_hook_active` bypass of real findings (bounded re-block); no SIGPIPE exit; documented output only
- [x] Tests drive the real script against fixture git repos, one case per defect with a control
- [x] Measure false positives on recent merged PRs; choose block vs feedback per finding class
- [x] Enable in `.claude/settings.json` (fired in Claude probe C1); Codex entry not shipped: it cannot run in SAM Codex sessions (round 1b), kept on sam/codex-rule-delivery-hook

### Docs
- [x] `scripts/quality/README.md`, `.claude/rules/00-rule-routing.md`, `AGENTS.md` notes as needed

## Acceptance criteria
- [x] Rule-73 check fails on the reintroduced incident shape and passes on current code, with controls
- [x] Measured hit count on current tree stated; rollout mode justified
- [x] Launch decision for 73 stated with its evidence (or 73 stays at launch)
- [x] Codex hook evidence from a real Codex session, or the exact reason it could not be obtained
- [x] Stop gate runs in every Claude Code session (observed); per-class block/feedback decision with numbers. Codex: not possible until SAM trusts repository hooks
- [x] All existing checks pass; `pnpm quality:agent-context-budget --check` passes (CI on PR #2790)

## Notes

- Main rejects direct pushes (ruleset), so this task file lives on the PR branch from the start.
- Codex round 1 (01M7HXMSG7M18TYKAEKHTBZEF0, control 01M7HXMZJ1H5N67FY2MP36HM72): the vm-agent's
  ~/.codex/config.toml has no trust entry for the repository, so Codex skips the project .codex
  layer: no repository hook (rule delivery or Stop gate) runs in SAM-managed Codex sessions.
  Making it run needs a vm-agent change that trusts repository hooks: a security-design decision
  for Raphaël (policy 1b930820), not made in this PR.
- 2026-11-16 ~11:05: workspace restored twice; .tmp and untracked state are lost on restore, so state lives here and in PR #2790.
- Reviews: task-completion-validator, go-specialist, security-auditor, test-engineer all returned; fixes in 0854ed500,
  608503822, f3b156c19 and the commit after it. Codex probe round 2 (01M7HY7P831WQG19HADM5JS85X) stalled on
  "failed to load workspace requirements" from nested codex exec; asked to wrap up.
- Codex rule-delivery hook and Codex Stop entry not shipped: branch sam/codex-rule-delivery-hook, decision idea 01M7J0TXAHGRY8CWA7Y7SJZAK0.
- Dependabot gomod entry added for scripts/quality/go-optional-fields (dependency-governance test).
