# Make the simplest viable solution the default

## Problem

Raphaël requested permanent steering guidance: always choose the minimum viable solution that fully meets current needs and stays easy to evolve. He explicitly authorized a PR and merge. The motivating secret-handoff design added a CLI and provider adapters before establishing whether an authenticated HTTP endpoint sufficed; that feature remains design-only.

## Research

- Constitution Principle X already requires KISS, YAGNI and justified abstractions/dependencies. Clarify this existing principle instead of introducing another one.
- Root AGENTS.md and CLAUDE.md are agent entrypoints; both need a concise visible reminder and a link to Principle X.
- Context-loading guidance requires measuring instruction size and checking active instruction sources. Do not raise the context limit.
- No runtime behavior changes; no staging deployment or runtime test suite needed. This follows the docs-only exception in /do Phase 6 and scope-appropriate validation.

## Implementation checklist

- [ ] Clarify Principle X: smallest complete solution, existing capabilities first, current-need justification for added components, evolutionary design without speculative infrastructure, and preserved security/correctness/reliability/validation.
- [ ] Add matching concise reminders linking to Principle X in AGENTS.md and CLAUDE.md.
- [ ] Update constitution amendment metadata and check template compatibility.
- [ ] Measure context budget, verify instruction sources, inspect links and diff, and check formatting.
- [ ] Complete local documentation-sync and task-completion review before archive.

## Acceptance criteria

- Both agent entrypoints state the principle prominently and link to the same canonical section.
- Future-proofing means easy evolution, not speculative scope; minimum viable does not waive quality or security.
- Existing KISS/YAGNI/SDK guidance stays consistent; no new tooling or runtime code is introduced.
- Context overhead and validation evidence are recorded below.

## Delivery gates

PR CI, best-effort CodeRabbit request and wait, and merge are tracked in the PR and .do-state.md. This task record archives implementation validation, not an assertion that merge has already happened.

## Validation evidence

Pending.
