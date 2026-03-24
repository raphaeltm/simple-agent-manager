# External Service Integration Review

## When This Applies

This rule applies when a feature integrates with any external service: OAuth providers (Google, GitHub), cloud IAM (GCP WIF, AWS OIDC, Azure AD), payment processors, third-party APIs with client registration, or any service that requires out-of-band configuration by the user.

## Why This Rule Exists

The GCP OIDC deployment feature (PR #499) shipped with a per-project OAuth callback URI that made the feature unusable for self-hosters, and a WIF pool wildcard binding that enabled cross-project privilege escalation. Both issues passed 6 review agents because the reviews validated code against the spec — but the spec itself was wrong. Neither the spec author nor any reviewer simulated the external service setup experience or modeled multi-tenant IAM implications. See `docs/notes/2026-03-24-gcp-oidc-review-postmortem.md`.

## Mandatory Checks

### 1. Consumer Simulation (Self-Hoster Walkthrough)

Before marking any external integration complete, walk through the setup from a self-hoster's perspective:

1. **What does the self-hoster need to register** in the external service's console? (OAuth app, IAM provider, webhook URL, API key, etc.)
2. **What URIs, scopes, or permissions** must they configure? Write out the exact values.
3. **Are the URIs static or dynamic?** If dynamic (per-user, per-project, per-resource), verify the external service supports dynamic registration. Most OAuth providers do NOT support wildcard redirect URIs.
4. **Document the setup steps** in `docs/guides/self-hosting.md` in the same PR.

If the self-hoster would need to perform a manual action for each new entity (project, user, workspace), the design is wrong. Redesign to use a single static configuration point.

### 2. Multi-Tenant Threat Model

For any auth/IAM integration, explicitly answer these questions in the task file or PR description:

- **What happens if User A and User B both use this feature?** Can User A's credentials or tokens affect User B?
- **What happens if User A has two projects both connected to the same external account?** Can Project A's agent access Project B's resources?
- **What shared resources exist?** (WIF pools, OAuth apps, service accounts). For each shared resource, verify isolation is enforced at every layer.
- **What is the blast radius of a compromised token?** How long is it valid? What can it access? Can it be used to escalate to other projects/users?

### 3. External Service Constraint Check

Before implementing, research and document the external service's constraints:

- **OAuth providers**: Maximum redirect URIs per client? Wildcard support? Scope limitations?
- **Cloud IAM**: Binding scope options? Attribute condition support? Maximum bindings per resource?
- **Rate limits**: What are the external API's rate limits? Will the implementation stay within them?

Cite the specific documentation for each constraint. Do not assume a service supports a pattern without verification.

### 4. IAM Binding Scope (Mandatory for Cloud Provider Integrations)

When creating IAM bindings (GCP WIF, AWS OIDC trust, Azure federated credentials):

- **NEVER use wildcard bindings** (`principalSet://.../pool/*`) without explicit justification in the PR description
- **ALWAYS scope bindings to the specific entity** (SAM project, user, workspace) using attribute conditions
- **If attribute mappings exist but are not enforced in conditions**, they provide zero security value — either enforce them or remove them
- **Verify the binding by testing with a token from a DIFFERENT entity** — confirm it is rejected

### 5. OAuth Redirect URI Design

OAuth redirect URIs MUST be:
- **Static** — a single URI that works for all entities (projects, users, workspaces)
- **Registrable once** — the self-hoster registers it once in the OAuth provider's console
- **Context-free** — entity context (project ID, user ID) must be passed through the OAuth `state` parameter, NOT embedded in the URI

If a redirect URI contains a dynamic segment (`:id`, `${projectId}`), the design is wrong. The state parameter exists specifically for this purpose.

## Spec Review Gate

When a feature spec includes an external service integration, the spec MUST be reviewed for design-level correctness before implementation begins. The review must verify:

- [ ] All callback/redirect URIs are static
- [ ] All IAM bindings are scoped to the specific entity (no wildcards)
- [ ] All terminal UI states are specified (empty data, error recovery, loading between steps)
- [ ] Self-hoster setup steps are documented
- [ ] Multi-tenant threat model is documented

This review SHOULD happen when the spec is created (in the design conversation) or at minimum before implementation is dispatched. The implementing agent MUST NOT start coding until these items are verified.

## Quick Compliance Check

Before committing external service integration code:
- [ ] OAuth redirect URIs are static (no dynamic segments)
- [ ] IAM bindings are scoped per-entity (no pool-wide wildcards)
- [ ] Self-hoster setup documented in `docs/guides/self-hosting.md`
- [ ] Multi-tenant threat model answered in PR description
- [ ] External service constraints researched and cited
- [ ] Edge-case UI states specified and tested (empty data, errors, timeouts)
