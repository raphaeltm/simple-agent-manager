# Make the simplest viable solution the default

## Problem

Raphaël requested permanent steering guidance: always choose the minimum viable solution that fully meets current needs and stays easy to evolve. He explicitly authorized a PR and merge. The motivating secret-handoff design added a CLI and provider adapters before establishing whether an authenticated HTTP endpoint sufficed; that feature remains design-only.

## Research

- Constitution Principle X already requires KISS, YAGNI and justified abstractions/dependencies. Clarify this existing principle instead of introducing another one.
- Root AGENTS.md and CLAUDE.md are agent entrypoints; both need a concise visible reminder and a link to Principle X.
- Context-loading guidance requires measuring instruction size and checking active instruction sources. Do not raise the context limit.
- No runtime behavior changes; no staging deployment or runtime test suite needed. This follows the docs-only exception in /do Phase 6 and scope-appropriate validation.

## Implementation checklist

- [x] Clarify Principle X: smallest complete solution, existing capabilities first, current-need justification for added components, evolutionary design without speculative infrastructure, and preserved security/correctness/reliability/validation.
- [x] Add matching concise reminders linking to Principle X in AGENTS.md and CLAUDE.md.
- [x] Update constitution amendment metadata and check template compatibility.
- [x] Measure context budget, verify instruction sources, inspect links and diff, and check formatting.
- [x] Complete local documentation-sync and task-completion review before archive.

## Acceptance criteria

- Both agent entrypoints state the principle prominently and link to the same canonical section.
- Future-proofing means easy evolution, not speculative scope; minimum viable does not waive quality or security.
- Existing KISS/YAGNI/SDK guidance stays consistent; no new tooling or runtime code is introduced.
- Context overhead and validation evidence are recorded below.

## Delivery gates

PR CI, best-effort CodeRabbit request and wait, and merge are tracked in the PR and .do-state.md. This task record archives implementation validation, not an assertion that merge has already happened.

## Validation evidence

- `pnpm quality:agent-context-budget` passed. Before: root startup docs 49,750 bytes; after wording: 50,728 bytes (+978 bytes, ~245 estimated tokens across both entrypoints). One existing table whitespace adjustment reduces the final total by 7 bytes. No context-limit change.
- Session log inspection confirmed the active root instruction source is `/workspaces/simple-agent-manager/AGENTS.md`. The current session retains the pre-edit instructions; the change is near the top of the same source for future sessions. Codex CLI is not installed in this runtime.
- Prettier and `git diff --check` validate changed Markdown. The plan template already has Constitution Check/Complexity Tracking; other templates do not duplicate Principle X.
- Manual review confirms both relative constitution links resolve and the reminders match the canonical principle. No runtime tests/build/staging needed for prose-only changes.
- The workflow's task-only main push was rejected by the required Workers check; this task record travels through the feature PR instead. No bypass attempted.
- Local combined documentation-sync and task-completion reviewer: PASS; no findings. Independently confirmed links, semantic consistency, template compatibility, task coverage, diff check and final context budget of 50,721 bytes (+971 bytes).
