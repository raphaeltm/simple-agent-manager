# Codebase, Data Model, and Agent-Readiness Evaluation

Date: 2026-05-07

Source prompt: `docs/guides/deep-codebase-review-prompt.md`

## Purpose

This directory contains the durable output of the deep SAM codebase evaluation. It is organized so follow-up agents can implement recommendations without replaying the original review sessions.

## Track Reports

| Track | Report | Status |
| --- | --- | --- |
| 1. Data Model Integrity & Schema Design | `tracks/01-data-model.md` | Pending |
| 2. Data Flow & Cross-Boundary Communication | `tracks/02-data-flow.md` | Pending |
| 3. Code Organization & Agent Navigability | `tracks/03-code-organization.md` | Pending |
| 4. Coding Standards & Consistency | `tracks/04-coding-standards.md` | Pending |
| 5. Performance & Cost Efficiency | `tracks/05-performance-cost.md` | Pending |
| 6. Testing & Experiment Infrastructure | `tracks/06-testing-experiments.md` | Pending |
| 7. Security & Multi-Tenant Isolation | `tracks/07-security-isolation.md` | Pending |
| 8. Architecture Alignment & Technical Debt | `tracks/08-architecture-debt.md` | Pending |
| 9. Agent-Ready Repository Architecture | `tracks/09-agent-readiness.md` | Pending |

## Synthesis Artifacts

- `findings-index.md` — normalized list of findings across all tracks
- `implementation-backlog.md` — implementation-ready follow-up tasks grouped by priority and ownership
- `final-report.md` — final integrated evaluation report

## Finding Format

Each finding should use this shape:

```markdown
### [SEVERITY] Finding Title

**Track**: N - Track Name
**Location**: `file/path.ts:line_number`
**Category**: data-model | data-flow | navigability | standards | performance | testing | security | architecture | agent-readiness

**Finding**: What was observed.

**Impact**: What happens if this is not addressed.

**Recommendation**: What should be done, with specific code changes if applicable.

**Implementation Owner**: Suggested package/app or specialist skill.

**Effort**: S / M / L / XL
```

## Agent Instructions

Agents working on this evaluation must:

1. Use the `$do` skill.
2. Read `docs/guides/deep-codebase-review-prompt.md`.
3. Write findings into the assigned track report only.
4. Use specific code references with file paths and line numbers.
5. Commit and push work frequently to the assigned branch.
6. Avoid implementation changes unless explicitly requested; this phase is evaluation and task decomposition.
