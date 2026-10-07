# Preserve session runtime contract across sleep and wake

SAM task: 01M4AXFSY11GR95XTD2N68ZE6F. Source Idea: 01M47WCAGF4A18CC0DCHYFK6CP.

## Problem and research
Normal VM restore supplies neither profile overrides nor ACP interactions. Go restore hosts read process-local maps. VM recovery unconditionally uses conversation mode, dropping task completion/git semantics. Instant wake supplies neither settings nor task context. Model retention varies by adapter; degraded VM restore already forwards overrides. Preserve resolved settings rather than re-reading mutable profiles during wake.

Affected boundaries: agent-session-bootstrap.ts, node-agent-session-snapshots.ts, session-recovery-task.ts, vm-agent-container.ts, Go restore admission and host configuration. Snapshot routing/lifecycle fences and workspace callback authentication remain required. Latest main reconciled before implementation; no open PR currently implements this Idea. Wake-ready sibling owns delivery signaling; archive sibling owns lifecycle allowlists.

## Checklist
- [ ] Persist validated versioned resolved settings, ACP configuration, original task mode/callback context without secrets.
- [ ] Restore VM and Instant contracts before host load; retain normal and degraded recovery behavior.
- [ ] Preserve task completion and git delivery semantics; safe legacy fallback and malformed-data handling.
- [ ] Add meaningful regression tests for modes, settings, interactions, task/chat and both runtimes.
- [ ] Update affected user docs and source Idea.
- [ ] Run applicable local quality checks and CI.
- [ ] Complete independent Go, Cloudflare, security, test, constitution, docs and completion reviews.
- [ ] Coordinate bounded shared staging; real sleep→wake, answer Manual request card, restored task completion/push/PR; clean up owned resources.
- [ ] Archive only after completion validation; merge after normal gates and prove production deployment.

## Acceptance criteria
Manual/Plan never silently become Bypass on wake. Model/effort/provider selections survive independent of later defaults/profile edits. Permissions/forms/URLs remain enabled through the canonical Cloudflare request/answer path. Task wake retains original callback identity and git delivery behavior; conversations remain conversations. Both VM and Instant preserve these invariants; incomplete historical records use explicit conservative compatibility and corrupt contracts fail safely. No destructive historical migration or relaxed authorization.

## References
Source Idea full corrections fetched. Rules: runtime parity (61), VM rollout compatibility (54), callback auth (34), migration safety (31), staging verification (13), merge gate (25).
