---
name: prioritize
description: 'Identify what to work on next. Reconciles candidate work against already-merged code BEFORE ranking, so stale/shipped ideas are dropped. Use when asked what to work on next, how to prioritize the backlog, or to triage ideas/tasks/incidents into a ranked shortlist.'
---

# Identify Next Priorities

Read the full workflow from `.claude/commands/prioritize.md` and execute it.

## Quick Summary

1. **Step 0 — Reconcile (GATE, run FIRST)** — cross-check every candidate against merged code
   (`git log --grep`, `gh pr list --state merged`). Drop SHIPPED, re-scope PARTIAL, admit only
   OPEN work to ranking. SAM idea/task `status` and `priority` fields are unreliable — trust the
   code on main over the board.
2. **Step 1 — Gather signal** — four tiers, highest authority first: human intent (policies,
   knowledge, in-session asks) → production reality (incidents, CI, open PRs) → curated backlog
   (ideas, `tasks/backlog/`) → strategic direction (CLAUDE.md Recent Changes, SAM project knowledge).
3. **Step 2 — Rank survivors** — impact (×multiplier for security/data-integrity), evidence
   quality, effort/blast radius, reversibility, strategic fit, in-flight duplication. Security/
   correctness bugs and anything broken in prod jump the queue.
4. **Step 3 — Output** — ranked shortlist of actually-open work (each with its Step-0 proof), a
   separate stale-board cleanup list, and one recommended next action.

Read-only by default — don't create tasks/ideas/PRs unless asked.
