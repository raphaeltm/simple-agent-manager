# Post-Mortem: GCP OIDC Deployment Feature — Critical Design Flaws Shipped Through Full Review Pipeline

**Date**: 2026-03-24
**Severity**: Critical (security vulnerability + unusable feature for self-hosters)
**Feature**: Project-level GCP OIDC for Defang deployments (PR #499, merged 2026-03-24)
**Discovered by**: Human-initiated manual review, same day as merge

---

## What Broke

Three critical issues shipped to production in the GCP OIDC deployment feature:

1. **Per-project OAuth callback URI** — The callback URL embeds the project ID (`/api/projects/${projectId}/deployment/gcp/callback`), requiring a new Google Cloud Console redirect URI registration for every SAM project. Google doesn't support wildcard redirect URIs. This makes the feature **unusable for any self-hoster with more than one project**.

2. **WIF pool wildcard IAM binding** — The `principalSet` member uses a pool-wide wildcard (`principalSet://.../*`) instead of scoping to the specific SAM project. The `attribute.sam_project` mapping exists in the OIDC provider config but is never enforced in any IAM condition. This enables **cross-project GCP access** for users with multiple SAM projects.

3. **Empty GCP project list dead end** — When a user's Google account has no GCP projects, the UI renders an empty dropdown with no explanation and no recovery path. The user is stranded.

Additionally, 18 HIGH/MEDIUM issues were found across security (OAuth handle in URL, no rate limiting, raw GCP errors exposed, overly broad OAuth scope), UX (missing loading states, `window.confirm()`, feature absent from SettingsDrawer), and DX (zero documentation for self-hosters).

---

## Root Cause Analysis

### The per-project callback URI was a regression from the original spec

The original GCP OIDC task file (`2026-03-18-gcp-oidc-oauth-setup.md`, line 82) correctly specified a **single static callback**: `/auth/google/callback`. The project context was passed through the OAuth state parameter — the standard pattern.

When the deployment-specific feature was built 6 days later (PR #499), the implementing agent created a new per-project callback (`/api/projects/:id/deployment/gcp/callback`) without recognizing that this breaks Google's OAuth redirect URI model. The state parameter **already contained** `{ projectId, userId }` (line 57 of `project-deployment.ts`), making the URL-embedded project ID redundant.

**Why it wasn't caught**: Neither the spec for the deployment feature (`2026-03-24-project-gcp-oidc-deploy.md`) nor any reviewer questioned *why* the callback URL needed the project ID when the state parameter already carried it. The checklist item was "OAuth redirect (reuse google-auth pattern)" — but the implementing agent diverged from that pattern without flagging the divergence.

### The WIF wildcard was baked into the spec from day one

The original task file (`2026-03-18-gcp-oidc-oauth-setup.md`, line 268) literally contains:

```
"principalSet://iam.googleapis.com/projects/{projectNumber}/locations/global/workloadIdentityPools/sam-pool/*"
```

This wildcard was copied from GCP documentation examples without analyzing whether it was appropriate for SAM's multi-project model. The attribute mapping for `sam_project` was added (suggesting someone thought about per-project scoping) but no `attributeCondition` was added to enforce it.

The implementing agent faithfully implemented what the spec said. The 6 review agents (including a security auditor) reviewed what the code did but didn't question whether the IAM binding *should* be pool-wide.

**Why it wasn't caught**: The spec was treated as authoritative. No reviewer asked "what happens if User A has two SAM projects both connected to the same GCP project?" The security auditor checked for CSRF, token exposure, and credential storage — but didn't model the multi-tenant IAM implications of the WIF binding scope.

### The empty state was never specified

The task file's UI section says: "Disconnected state: 'Connect GCP' button → OAuth flow" and "Setup flow: project selection → setup → done." No acceptance criterion addresses what happens when the project list is empty, when loading takes time, or when the user needs to recover from an error. The implementing agent built exactly what was specified.

**Why it wasn't caught**: The UI/UX reviewer agent was dispatched but focused on layout, accessibility, and visual testing (30 Playwright screenshots). Edge-case data scenarios (empty lists, error recovery) were not in the review prompt. The Playwright visual audit rule (`.claude/rules/17-ui-visual-testing.md`) requires testing with "empty states" — but the test mock used `projects: []` for the *deployment credential* empty state, not the GCP project list empty state during the OAuth flow.

---

## Timeline

| Date | Event |
|------|-------|
| 2026-03-17 | OIDC federation research task created and completed |
| 2026-03-18 | GCP OIDC OAuth task created with WIF wildcard in spec (line 268) |
| 2026-03-18 | PR #452 merged — original GCP OIDC with single `/auth/google/callback` |
| 2026-03-18 | Audience URI bugs discovered and fixed (ab4e519c, c4dbad00) |
| 2026-03-24 | Design conversation between human and agent — spec created as a SAM idea |
| 2026-03-24 | Human dispatches single monolithic task for full implementation |
| 2026-03-24 | Implementation agent builds feature, dispatches 6 review agents |
| 2026-03-24 | All 6 reviewers report PASS — "all findings addressed" |
| 2026-03-24 | Staging deployment green, Playwright verification passes |
| 2026-03-24 | PR #499 merged to main |
| 2026-03-24 | Human asks "do I need a separate OAuth app?" — triggers manual review |
| 2026-03-24 | 4 specialist agents dispatched for thorough review — find 3 CRITICAL, 10 HIGH, 8 MEDIUM issues |

**Total time from merge to discovery: < 1 hour.** But only because the human asked a casual question that led to scrutiny.

---

## Why It Wasn't Caught: Systemic Analysis

### 1. Spec fidelity treated as sufficient review

The implementing agent's primary frame was "implement what the spec says." The review agents' primary frame was "does the code match what was intended?" Neither frame asks "is the design itself correct?" This is the fundamental gap: **review agents validate implementation against intent, but nobody validates intent against reality**.

The WIF wildcard was in the spec. The per-project callback was in the implementation plan. Both were wrong. But since they matched the "intent," review passed.

### 2. Security review lacked cloud-provider domain expertise

The security auditor agent checked for standard web security issues (CSRF, token exposure, credential storage, OWASP patterns). It did not model GCP IAM implications — specifically, what `principalSet://.../*` means in a multi-tenant context vs. `principal://.../{subject}`. This is domain-specific security knowledge that a generic security review doesn't cover.

Similarly, the cloudflare-specialist reviewed D1/KV usage patterns but doesn't have GCP IAM expertise.

### 3. No "consumer simulation" in review

No reviewer simulated the experience of a self-hoster setting up this feature. If any agent had walked through "I'm a self-hoster, I need to register a redirect URI in Google Cloud Console — what URI do I use?", the per-project callback problem would have been immediately obvious.

### 4. Monolithic task dispatch eliminated human checkpoints

The human designed the feature in a conversation, then dispatched the entire implementation as a single task. The implementing agent went from research → implementation → review → staging → merge in one session with zero human checkpoints on intermediate artifacts. The human never reviewed:
- The task file's checklist (which had the per-project callback baked in)
- The WIF binding code (which matched the original spec's wildcard)
- The UI's empty-state behavior (which was never specified)

### 5. Visual testing caught layout bugs but not interaction bugs

The 30 Playwright visual audit tests verified that the UI renders correctly with normal data. But they used mock data that only covered the happy path. The "empty state" test mocked the deployment credential as disconnected — not the GCP project list as empty during the OAuth flow.

### 6. Staging verification checked page loads, not feature functionality

Staging verification confirmed the "Deploy to Cloud" section was visible and the "Connect Google Cloud" button rendered. But nobody actually clicked the button and went through the OAuth flow — because that requires real Google OAuth credentials configured on staging. The verification was surface-level.

---

## Class of Bug

**Design-level errors that pass implementation review because the review validates code against design, not design against reality.**

This is distinct from:
- Implementation bugs (code doesn't match intent) — caught by existing review agents
- Integration bugs (components don't connect) — caught by capability tests
- Regression bugs (working thing breaks) — caught by regression tests

Design-level errors require a reviewer who questions the design itself: "Should the callback URI include the project ID?" "Should the WIF binding be pool-wide?" "What happens when the project list is empty?" These are questions about whether the spec is correct, not whether the code matches the spec.

---

## Process Fixes

### New Rule: External Service Integration Review (Proposed)

When a feature integrates with an external service (OAuth provider, cloud IAM, payment processor, etc.), the review phase MUST include:

1. **Consumer simulation**: Walk through the setup from the perspective of a self-hoster configuring the external service. What do they need to register? What URIs, scopes, permissions? Document the exact steps.

2. **Multi-tenant threat model**: For any IAM/auth integration, explicitly model: "What happens if User A and User B both use this? What happens if User A has two projects?" If the answer involves shared resources (WIF pools, OAuth apps), verify that isolation is enforced at every layer.

3. **External service constraint check**: Verify that the implementation respects the external service's constraints (e.g., Google doesn't support wildcard redirect URIs, AWS has a 50-role-per-policy limit, etc.). This requires domain-specific knowledge — cite the documentation.

### New Rule: Spec Design Review Before Implementation Dispatch

When dispatching a feature implementation task, the human MUST review the spec/task file for design-level correctness before the implementing agent starts coding. Specifically:
- OAuth/auth flows: verify callback URIs are registrable and static
- IAM bindings: verify scope is minimal (no wildcards without justification)
- UI flows: verify all terminal states are specified (empty, error, loading, success)

### Enhancement: Security Auditor Agent Prompt

The security auditor agent prompt should be enhanced to include:
- "For any IAM binding (GCP WIF, AWS IAM, Azure AD), verify the binding scope is per-entity, not wildcard. Model the multi-tenant implications."
- "For any OAuth integration, verify the redirect URI is static and registrable without per-resource configuration."
- "Simulate the external service configuration from a self-hoster's perspective."

### Enhancement: UI/UX Review Must Include Edge-Case Data Scenarios

The UI/UX reviewer should explicitly check:
- Empty data from API calls during multi-step flows (not just empty initial state)
- Loading states between async steps
- Error recovery paths for every async operation
- What happens when the user cancels mid-flow

---

## References

- PR #499: https://github.com/raphaeltm/simple-agent-manager/pull/499
- PR #452: https://github.com/raphaeltm/simple-agent-manager/pull/452
- Original spec: `tasks/archive/2026-03-18-gcp-oidc-oauth-setup.md`
- Implementation task: `tasks/archive/2026-03-24-project-gcp-oidc-deploy.md`
- Design conversation: SAM session `e4c803f1-5b42-49fe-8e6d-dd8b267ffeb9`
- Implementation session: SAM session `97f2c38e-f1bd-46cc-ad1a-0481fd9db016`
- Fix tasks dispatched: `01KMGQSVZCHZW0197NY9E380W1` (callback URI), `01KMGQT6ACNT78EQ787J38BQNY` (WIF binding), `01KMGQTMY40CZXA9VR1BVQTHZD` (empty state UX)
