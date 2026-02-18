# Research: Projects and Tasks Foundation MVP

**Phase 0 output** | **Date**: 2026-02-18

## Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Project system-of-record | SAM D1 as primary source of truth | Keeps MVP independent from external sync/auth complexity while preserving future integration path |
| Project repository model | Single primary repository per project in MVP | Minimizes schema and UX complexity while retaining upgrade path to multi-repo |
| Task relationship model | Separate parent-child and dependency edges | Mirrors established tracker patterns and avoids semantic ambiguity |
| Dependency validation | Enforce DAG (no cycles) + blocked-state gating | Required for predictable delegation sequencing |
| Delegation mode | Manual task -> workspace assignment only | Aligns with orchestration design Phase 1 and reduces operational risk |
| Operational safeguards | Configurable limits and timeouts | Required by Constitution Principle XI and informed by issue-link scale risks |

## Research Questions & Findings

### R1: What Project model should we adopt for MVP?

**Decision**: Use user-owned Project entities in SAM, each linked to one GitHub installation + one primary repository in MVP.

**Rationale**:
- GitHub Projects are flexible planning containers with custom fields and multiple layouts (table, board, roadmap), which validates project-centric planning UX.
- SAM already has user-owned GitHub installations and repository listing; project records can safely reference that existing ownership boundary.

**Alternatives considered**:
- Workspace-only model (status quo): rejected because it does not support backlog-first planning.
- Multi-repo project at MVP start: rejected as unnecessary complexity for first release.

**Sources**:
- GitHub Projects overview: https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects

---

### R2: Should MVP use external GitHub Project sync as primary state?

**Decision**: No. Keep SAM as system-of-record for Project/Task state in MVP.

**Rationale**:
- GitHub REST support for Projects (classic) has token-model differences that complicate a single robust auth path; e.g., user-owned project view endpoints do not support GitHub App installation tokens, while org-owned endpoints do.
- SAM currently uses GitHub App installation tokens as a core integration pattern, so forcing external state as primary would add auth/ownership complexity too early.

**Alternatives considered**:
- Full external sync from day one: rejected for auth surface complexity and migration risk.
- Read-only mirror from GitHub: deferred; may be revisited once internal model stabilizes.

**Sources**:
- GitHub REST Projects views token compatibility: https://docs.github.com/en/rest/projects/views?apiVersion=2022-11-28
- GitHub App installation auth: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

---

### R3: How should tasks model decomposition vs ordering constraints?

**Decision**: Support both:
- Parent-child decomposition (`parentTaskId`)
- Explicit dependency edges (`taskDependencies`)

**Rationale**:
- GitHub distinguishes sub-issues (breakdown hierarchy) from issue dependencies (blocked by / blocking), validating separate constructs.
- Keeping these concepts distinct improves clarity for future orchestration and avoids overloading one relation type.

**Alternatives considered**:
- Parent-child only: rejected (cannot express cross-branch blocking cleanly).
- Dependencies only: rejected (loses hierarchical planning UX).

**Sources**:
- GitHub sub-issues: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- GitHub issue dependencies: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies

---

### R4: What validation rules are required for dependencies?

**Decision**: Enforce project-scoped DAG rules:
- No self-dependencies
- No cross-project dependency edges
- No cycle creation
- Blocked tasks cannot enter executable states

**Rationale**:
- Dependency relations in trackers are easy to create; without server-side graph validation, planners can create deadlocked/cyclic workflows.
- Jira documentation explicitly discusses cyclic issue-link loops and operational burden of overlinked issues, supporting proactive guardrails.

**Alternatives considered**:
- Allow cycles and rely on UI warnings: rejected (insufficient for API clients and automation).
- Hard delete conflicting edges automatically: rejected (non-deterministic and user-hostile).

**Sources**:
- Jira issue links: https://support.atlassian.com/jira-software-cloud/docs/link-issues/
- Jira cyclic issue loops: https://support.atlassian.com/jira/kb/how-to-fix-cyclic-issue-loops/
- Jira excessive links guidance: https://support.atlassian.com/jira/kb/how-to-identify-jira-issues-with-too-many-issue-links-and-comments/

---

### R5: What should we learn from other trackers for dependency scale limits?

**Decision**: Add configurable dependency and task limits in API layer.

**Rationale**:
- Linear allows many relationships and rich relation types, which is useful but can increase graph complexity quickly.
- Combined with Jira guidance on overlinked issues, this supports setting configurable caps from day one.

**Alternatives considered**:
- No limits in MVP: rejected due to risk of pathological graphs and slow list/dependency queries.
- Hardcoded limits: rejected by Constitution Principle XI.

**Sources**:
- Linear issue relations/dependencies: https://linear.app/docs/issues/relations
- Jira excessive links guidance: https://support.atlassian.com/jira/kb/how-to-identify-jira-issues-with-too-many-issue-links-and-comments/

---

### R6: Which delegation mode is appropriate for MVP?

**Decision**: Manual delegation only (`task -> workspace`) with callback-capable status updates.

**Rationale**:
- Matches orchestration vision Phase 1: validate project/task data model and UX before automation.
- Reuses proven workspace runtime and ownership controls already in the platform.

**Alternatives considered**:
- Automatic scheduler/orchestrator in MVP: rejected as out-of-scope for first two primitives.

**Sources**:
- Internal design vision (Phase 1): `docs/design/orchestration-platform-vision.md`

## Implications for Phase 1 Design

1. Data model will prioritize clarity and validation over automation.
2. API contracts will expose project-scoped task/dependency operations with strict ownership enforcement.
3. Limits and timeout knobs will be environment-configurable from initial implementation.
4. External tracker sync remains explicitly out-of-scope for MVP, but contracts preserve extension paths.
