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
6. Verify any suspected environment prerequisites or blockers with direct checks before proceeding or reporting that you are blocked

## Required Behavioral Rules

- **Up-to-date docs first**: For `external-api-change`, use Context7 when available. If unavailable, use official primary documentation and record what was used.
- **External service integration design review first**: For features integrating with OAuth providers, cloud IAM (GCP WIF, AWS OIDC), or any service requiring out-of-band user configuration, complete the design checks in `19-external-service-integration.md` before writing code. Verify: static callback URIs, scoped IAM bindings, self-hoster setup documented, multi-tenant threat model answered.
- **Cross-component impact first**: For `cross-component-change`, map dependencies and affected components before edits. Write a data flow trace (see `10-e2e-verification.md`) that cites specific code paths at each system boundary.
- **Billing entity check first**: For usage, quota, billing, or cost changes, identify the billable resource before editing. If the stored events are more granular than the billed entity (for example workspace events on a shared node), document the aggregation boundary and add overlap tests that prove shared-resource time is counted once.
- **Assumption verification first**: When a spec, task, or document claims "existing X works" or "X is functional," verify the claim with a test or manual check before building on it. Record what was verified and how. "I read the code and it looks right" is not verification.
- **Environment verification first**: When you suspect a blocker such as missing GitHub auth, missing dependencies, missing binaries, missing files, or insufficient permissions, verify it with the cheapest direct check before telling the human you are blocked. If the first check fails, also try the obvious repo-documented recovery step when one exists.
- **Code usage analysis first**: For business logic/contract changes, inspect existing usage and edge cases before implementation.
- **Docs sync by default**: If behavior or interfaces change, update docs/specs in the same PR or explicitly justify deferral.

## Blocker Reporting Evidence

When reporting that you cannot continue, include:

1. The assumption you tested
2. The concrete command(s) or inspection step(s) you ran
3. The result
4. Any repo-documented recovery step you attempted
5. Why the remaining blocker is real

Statements like "it probably won't work," "credentials seem unavailable," or "the package is likely missing" are not acceptable blocker evidence.

## Speckit and Non-Speckit Enforcement

- **Non-Speckit tasks**: Complete full preflight at task start before any code edits.
- **Speckit tasks**: Complete preflight before `/speckit.plan`, and re-run preflight before `/speckit.implement`.

## PR Evidence Requirement

All AI-authored PRs MUST include preflight evidence using the block in `.github/pull_request_template.md`. CI validates this evidence on pull requests.
