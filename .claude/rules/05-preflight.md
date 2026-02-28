# Agent Preflight Behavior

Before writing ANY code, agents MUST complete preflight behavior checks.

This policy is defined in `docs/guides/agent-preflight-behavior.md` and enforced through PR evidence checks in CI.

## Mandatory Preflight Steps (Before Code Edits)

1. Classify the change using one or more classes:
   - `external-api-change`, `cross-component-change`, `business-logic-change`, `public-surface-change`
   - `docs-sync-change`, `security-sensitive-change`, `ui-change`, `infra-change`
2. Gather class-required context before editing files
3. Record assumptions and impact analysis before implementation
4. Plan documentation/spec updates when interfaces or behavior change
5. Run constitution alignment checks relevant to the change

## Required Behavioral Rules

- **Up-to-date docs first**: For `external-api-change`, use Context7 when available. If unavailable, use official primary documentation and record what was used.
- **Cross-component impact first**: For `cross-component-change`, map dependencies and affected components before edits. Write a data flow trace (see `10-e2e-verification.md`) that cites specific code paths at each system boundary.
- **Assumption verification first**: When a spec, task, or document claims "existing X works" or "X is functional," verify the claim with a test or manual check before building on it. Record what was verified and how. "I read the code and it looks right" is not verification.
- **Code usage analysis first**: For business logic/contract changes, inspect existing usage and edge cases before implementation.
- **Docs sync by default**: If behavior or interfaces change, update docs/specs in the same PR or explicitly justify deferral.

## Speckit and Non-Speckit Enforcement

- **Non-Speckit tasks**: Complete full preflight at task start before any code edits.
- **Speckit tasks**: Complete preflight before `/speckit.plan`, and re-run preflight before `/speckit.implement`.

## PR Evidence Requirement

All AI-authored PRs MUST include preflight evidence using the block in `.github/pull_request_template.md`. CI validates this evidence on pull requests.
