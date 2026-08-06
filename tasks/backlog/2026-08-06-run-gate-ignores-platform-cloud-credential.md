# `/tasks/:taskId/run` pre-check ignores the platform cloud credential

## Problem

`POST /api/projects/:projectId/tasks/:taskId/run` gates on the **caller's own** cloud-provider
credential row before it will start a run:

```ts
// apps/api/src/routes/tasks/run.ts
const [credential] = await db
  .select({ id: schema.credentials.id })
  .from(schema.credentials)
  .where(and(
    eq(schema.credentials.userId, userId),
    eq(schema.credentials.credentialType, 'cloud-provider')
  ))
  .limit(1);

if (!credential) {
  throw errors.badRequest('Cloud provider credentials required. Connect your account in Settings.');
}
```

That predicate has **no platform fallback**, but the code that actually provisions the node does:
`node-steps.ts:229` → `resolveCredentialSource` (`services/provider-credentials.ts:414`,
"Falls back to platform credentials when no user credential is found", tiers
project-attachment → user-attachment → platform default).

So the pre-check is stricter than the operation it guards. A user for whom provisioning would
succeed is rejected up front with a message telling them to connect an account they do not need.

## Why this matters now

This is the direct blocker on the feature PR #1740 shipped. That PR widens task lifecycle routes so
any project member with `task:write` can run a shared task — but a member without their own cloud
credential still cannot, even though the platform Hetzner credential would provision the node.

It also contradicts a standing project policy (CLAUDE.md, Architecture Principles #1):

> A user does NOT need their own cloud credential for SAM to provision workspaces or deployment
> nodes. Provider resolution falls back **user credential → platform credential**.

## Context (where this was found)

Found during staging verification of PR #1740 on 2026-08-06. Staging D1 has exactly one
cloud-provider credential row (PRIMARY / `serverspresentation2025`); SECONDARY (`dfv31`) has none,
despite being an `admin` member of the shared project with full `task:write`. That made the
"member B runs member A's task" path unreachable end-to-end on staging — it is covered by
discriminating unit tests instead (`shared-project-task-lifecycle-positive.test.ts`).

## Acceptance Criteria

- [ ] The `/run` pre-check resolves credentials through the same path provisioning uses, so an
      enabled platform credential satisfies it (do not duplicate the tier logic — call the shared
      resolver).
- [ ] A member with no personal cloud credential can run a shared-project task when a platform
      credential is enabled.
- [ ] When neither a user nor a platform credential resolves, the request still fails fast with a
      clear, actionable message.
- [ ] Behavioral tests cover all three branches: user credential present, no user credential +
      enabled platform credential, and neither present.
- [ ] Audit the other routes that gate on a raw `credentials` lookup for the same divergence
      (grep `credentialType, 'cloud-provider'`) and either fix or explicitly justify each.

## References

- `.claude/rules/28-credential-resolution-fallback-tests.md` — required fallback-branch test matrix
- CLAUDE.md Architecture Principles #1 (platform credential fallback)
- PR #1740 (shared-project task lifecycle authorization)
