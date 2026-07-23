# Server-Side Node-Class / Identity Gates — Never Trust a Client-Supplied Identifier or Agent Abstention

## When This Applies

This rule applies whenever a control-plane endpoint or background sweep makes a **security- or
lifecycle-sensitive decision that depends on WHICH node / workspace / tenant / node-class a request
concerns**. The canonical examples are the three pre-existing gaps that BYO / user-owned node
self-enrollment weaponized (Phase 0, idea `01KY7M8N1RBC4ZV6ZKSNG878B3`):

- **Callback-token binding**: `agent-activity-callback.ts` / `node-acp-heartbeat.ts` authorized on a
  client-supplied `body.nodeId` instead of the token's own verified identity (`payload.workspace`).
- **Origin CA issuance**: `node-lifecycle.ts` issued a platform-wide `*.{BASE_DOMAIN}` wildcard cert
  to any node with a valid callback token, relying on "the host-mode agent simply won't call this"
  rather than a server-side `nodeClass` gate.
- **Heartbeat A-record backfill**: the backfill ran unconditionally, relying on the agent to
  suppress it for tunnel nodes rather than gating on `tunnelId` server-side.
- **Teardown sweeps**: `node-cleanup.ts` destroy queries selected candidates without excluding
  `node_class='user-owned'`, so a machine SAM does not own could be swept.

## Why This Rule Exists

Each gap "worked" as long as SAM was the only party that could mint node credentials and the only
agent binary in the field. Self-service enrollment (any user registers a machine) removes that
implicit trust: every user now holds a valid node JWT, controls the agent binary on their own
hardware, and can craft arbitrary request bodies. The invariant that must hold is: **the server
decides authorization and lifecycle from values IT verified — the JWT's bound identity and the
resource row's own columns — never from a field the caller supplied or from an assumption about how
a well-behaved agent will act.**

## Class of Bug

**Authorization / lifecycle trust placed in a client-controlled input or an agent's good behavior.**
The tells:
- Comparing a request-body identifier (`body.nodeId`) against a looked-up row, without also binding
  the caller's *verified* identity (`payload.workspace`) to that row.
- A comment that says the safe behavior is "the agent won't ask" / "the agent skips this" / "we
  intentionally do NOT cross-check" — an agent-side choice is not a server-side control.
- A destroy/flag/mutate query whose predicate omits a class/ownership column that changes whether
  the row may be touched at all.

## Hard Requirements

1. **Bind to the token's own verified identity.** When an endpoint accepts a callback/bearer token
   and then acts on a node/workspace/session, require the token's bound identity
   (`payload.workspace` for the verified scope) to match the resource — mirroring
   `verifyNodeCallbackAuth` / `verifyWorkspaceCallbackAuth`. A client-supplied identifier may be used
   only as defense-in-depth, never as the sole authorization.

2. **Gate on the resource's own server-verified attributes, server-side.** When issuance, teardown,
   backfill, or any privileged action must be withheld for a class of resource (`node_class`,
   `transport`, `runtime`, ownership), load the row and enforce it in the handler. Do NOT rely on the
   agent choosing not to call the endpoint, and do NOT rely on a client flag.

3. **Every destroy/flag/mutate candidate query carries the class/ownership guard.** A background
   sweep, cron, or reconcile that can destroy or terminally mutate rows MUST include the
   class/ownership predicate (e.g. `node_class != 'user-owned'`) in EVERY candidate query — not just
   the "obvious" one. Enumerate them (see `.claude/rules/47-control-loop-io-budget.md`).

4. **Fail closed.** When the bound identity is absent/mismatched or the row lookup fails in a way
   that leaves the class ambiguous for a privileged action, reject — do not fall through to the
   permissive path. (Lifecycle guards may fail to "managed" ONLY when a second backstop, e.g. the
   cleanup class guard, still protects the row.)

## Required Tests

- A **discriminating** authorization test: construct a request where the caller holds a valid token
  for their OWN resource but targets a DIFFERENT tenant's resource (supplying the victim's real
  identifier in the body). Assert 403 AND that no state mutated. Verify it FAILS on the pre-fix code
  (the forgery is accepted) — proving the binding, not the body-check, is what rejects it.
- A **server-side gate** test proving the privileged action is withheld for the guarded class even
  when the request explicitly asks for it (the agent-abstention assumption is not relied upon).
- A **two-sweep zombie test** (rule 47) proving a guarded-class row is never selected by any
  destroy/flag query across repeated sweeps, with an equivalent unguarded-class row as the
  discriminating control.

## Quick Compliance Check

Before merging an endpoint or sweep whose behavior depends on which node/workspace/tenant/class:
- [ ] Authorization binds the token's verified identity to the resource, not a client body field
- [ ] Any withheld-for-a-class action is gated server-side on the row's own columns, not agent choice
- [ ] Every destroy/flag/mutate candidate query includes the class/ownership predicate
- [ ] The path fails closed on missing/mismatched identity for privileged actions
- [ ] A discriminating cross-tenant test exists and is proven to fail on the pre-fix code

## References

- Idea `01KY7M8N1RBC4ZV6ZKSNG878B3`; library `/engineering/byo-nodes/` (critique-security, critique-architecture)
- `.claude/rules/28-credential-resolution-fallback-tests.md` — credential-trust-boundary tests
- `.claude/rules/34-vm-agent-callback-auth.md` — callback JWT auth routing
- `.claude/rules/47-control-loop-io-budget.md` — enumerate every sweep candidate query
- `.claude/rules/11-fail-fast-patterns.md` — identity validation + fail-closed at boundaries
