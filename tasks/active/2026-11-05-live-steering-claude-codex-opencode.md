# Live steering across Claude, Codex and OpenCode

## HARD CONSTRAINT (from Raphaël's brief, task 01M6MHNBM96JSAMJ0GNTPM2AYP)

**DRAFT PR ONLY.** Do not mark ready, do not merge, do not deploy to production. Stop at a
reviewable draft PR with implementation, validation evidence and honest remaining limitations.
Staging validation is permitted under normal coordination/cost/cleanup rules.

- SAM idea: 01M2EPH9WGDYFDQBZCP9QY1FDE (section "2026-11-05 implementation proposal")
- Related: idea 01M6MFTF86JXR0NA90BH0YVZQG (prompt retry noise), parent research session
  879cf7e8-0c2b-487e-ac01-9812ae09d569
- Branch: `sam/build-draft-pr-implementing-pm2ayp`

## Problem

A message sent to a busy agent today waits for the turn to end (`deliver`), or stops the turn
(`interrupt`+ stop-and-deliver). There is no way to add context to the running turn. All three
runtimes have (or can cheaply get) a harness-level steering path: ACP extension
`_session/steering`. SAM must offer three explicit operations: Queue next, Steer now, Stop.

## Research findings (verified 2026-11-05 against main 9399deb16 and published artifacts)

### Adapter contracts (artifacts inspected, not executed)

- Wire method `_session/steering`, request
  `{sessionId, prompt:[ContentBlock], _meta:{steering:{idleBehavior:"promptRequired"}}}`.
  Results: `{outcome:"injected"}`, `{outcome:"promptRequired",reason:"noRunningTurn"}`,
  `{outcome:"startedNewTurn"}` (legacy default, detached unowned turn), Codex-only `{outcome:"failed"}`.
  Advertised in top-level `InitializeResponse._meta.steering.supported`. No input id / dedup in any
  adapter; no `user_message_chunk` echo of steered text (SAM persists + mirrors it itself).
- **Claude** `@agentclientprotocol/claude-agent-acp@0.81.2` (`dist/acp-agent.js`): honours
  `promptRequired` (idle → returns without consuming input). Running → pushes input with priority
  `now`, or `later` while permission/elicitation is pending; turn settles only after a result that
  answers the steer. Unknown session → JSON-RPC internal error. Usable as shipped.
- **Codex** stock `@agentclientprotocol/codex-acp@2.1.1` and SAM C2 `2.1.1-sam-c2.2`:
  `parseSessionSteerParams` drops `_meta`; idle/race falls through to `startNewTurnFromSteering`
  → detached turn. `promptRequired` first appears upstream in 2.4.0 (needs codex CLI ^0.165).
  Decision: backport the two small 2.4.0 changes into the C2 adapter patch as `2.1.1-sam-c2.3`
  and additionally advertise `_meta.steering.idleBehaviors:["promptRequired"]`. Stock npm 2.1.1
  sessions are NOT steerable (visible queue fallback). C2 is selected by
  `SAM_CODEX_C2_CANDIDATE=1` profile env or ACP forms/URL interactions
  (`codex_staging_candidate.go:selectSessionCodexRuntime`).
- **OpenCode** v2.2.5 (tag commit 9bbb8ce18c80…): ACP `agent.ts` registers no `_session/steering`
  (methodNotFound); `turn.ts` rejects a concurrent ACP prompt. Core `Session.prompt` accepts
  `{id, delivery:"steer"|"queue", resume}` and promotes pending steers at step boundaries. SAM
  installs a Bun-compiled single binary from GitHub releases (`opencode_install.sh`, per-target
  sha256); npm has no 2.2.5, so the shipped JS cannot be edited. A side proxy is not viable
  (`opencode acp` spawns its own `serve` child with a random password/port). Decision: source
  patch to the ACP layer (agent.ts/service.ts/turn.ts) reusing the active Turn and the native
  steer inbox; build a pinned binary reproducibly; publish; update install pins.

### SAM code paths

- VM: `POST /workspaces/{ws}/agent-sessions/{sid}/prompt` → `handleVersionedPromptDelivery`
  (`internal/server/workspaces.go`), receipts in `internal/persistence/execution_protocol.go`
  (`prompt_delivery_receipts`, migration V11). Capabilities: `Server.agentCapabilities()`.
  `SessionHost.AcceptPrompt` single-flight gate `beginPromptForDeliveryWithMessageID`
  (`session_host_prompt_state.go`). Initialize captures only `LoadSession`
  (`session_host_handshake.go:initializeACP`). SDK `coder/acp-go-sdk v0.13.5` has
  `ClientSideConnection.CallExtension` (safe concurrently with blocked `Prompt`; responses routed by
  id; waits for prior notifications → never call holding `h.mu`) and `InitializeResponse.Meta` /
  `AgentInfo`.
- API: `session_inbox` queue (`prompt-delivery.ts`): head-of-line per target
  (`noEarlierDeliverySql`), shared busy backoff (`prompt_delivery_target_backoff`), claim engine,
  `applyPromptDeliveryResult`; runner `prompt-delivery-runner.ts` calls
  `DefaultVmPromptDeliveryAdapter.submit/reconcile`; urgent stop-and-deliver in
  `prompt-delivery-interrupt.ts`. Accepting a prompt calls `sessionState.markPromptAccepted` (new
  epoch) — a steer must NOT. Next DO migration: `072`.
- Entry points all converge on `acceptPromptDelivery`: composer (`send-chat.ts`, hard-coded
  `deliver`), MCP `send_durable_message` (`routes/mcp/mailbox-tools.ts`), event wake
  (`project-events-wake-prompt.ts`; `runtime_steer` resolves to `recorded_not_injected` in
  `services/project-event-subscriptions-access.ts:resolveDeliveryPreference`).
- Web: composer `ProjectChatComposer` via `SessionFooter`/`FollowUpInput`; send
  `useSessionLifecycle.handleSendFollowUp` → `sendFollowUpPrompt`; Stop is CompletionDock
  Interrupt. Web does not consume `mailbox.*` events; no delivery chips exist.

## Design

1. Intent `deliveryIntent: 'queue' | 'steer'` separate from `messageClass`. Steer is only valid for
   non-urgent classes (`notify`/`deliver`); urgent classes keep stop-and-deliver.
2. VM: capture steering support at Initialize; a steer is only attempted when the loaded adapter
   proves `promptRequired` (explicit `idleBehaviors` advertisement, or Claude ACP identity
   ≥ 0.81.2). New endpoint `POST .../steer` + `GET .../steer-receipts/{id}` with a separate
   `steer_delivery_receipts` table (so a fallback can reuse the delivery ID on `/prompt`).
   States: accepted → in_flight (claimed before the RPC) → injected | not_consumed | ambiguous.
   Lost response → duplicate returns stored state; in_flight owned by an earlier runtime →
   ambiguous (never replayed). SessionHost.Steer is serialized per host, binds to the current
   prompt attempt (epoch), never resets timeouts/idle, never creates an epoch.
3. API: `session_inbox.delivery_intent` lane: steer rows have their own head-of-line and skip the
   busy backoff. Steer outcome: steered → acked with `steer_outcome='steered'` (no
   `markPromptAccepted`); prompt_required/unsupported/idle/sleeping/old VM → convert row to the
   queue lane (visible `steer_outcome='queued_fallback'` + reason) and nudge; lost response →
   receipt lookup; unknown → ambiguous (terminal, surfaced).
4. Entry points: composer `deliveryIntent`, MCP `send_durable_message.deliveryIntent`, event
   subscriptions `runtime_steer` (authorized) → queued with steer intent.
5. UI: while working, composer offers "Steer now" / "Queue next" (Stop stays in the dock). User
   messages show truthful delivery chips (queued, steering, steered into current turn, queued
   instead, couldn't confirm, not delivered).

## Implementation checklist

### Adapters (artifacts)
- [x] Codex: C2.3 adapter patch (1093 adapter tests; review build run 41948124473; release acp-codex-runtime-c2.3-codemode2; pins updated) (promptRequired backport + tests),
      provenance, build script versions; run review build; package; publish release; update pins
      (`codex_staging_candidate.go`, installer, prepare/publish scripts, `codex-runtime.ts`,
      verify image script, tests)
- [x] OpenCode: ACP steering patch (107 ACP tests; CI run 41952487055; release opencode-v2.2.5-sam-s1; pins updated) (agent.ts/service.ts/turn.ts + tests), reproducible build
      script + workflow, publish release, update `opencode_install.sh` + manifest pins/version check
- [x] Claude: no artifact change; gate on identity (0.81.2+)

### VM agent (Go)
- [x] Capture `_meta.steering` + `agentInfo` at Initialize; `steeringSupport` per host
- [x] `SessionHost.Steer` (serialized, attempt-bound, bounded ctx, no lock across RPC)
- [x] Mirror steered user text to viewers + message reporter with the transcript message ID
- [x] `steer_delivery_receipts` migration + store methods
- [x] `/steer` and `/steer-receipts/{id}` handlers; capability advertisement `steering`
- [x] Tests: injected mid-prompt, idle → not consumed, no capability, cancel/checkpoint race,
      duplicate ID, conflict, runtime change → ambiguous, no epoch/timeout reset, single-flight kept

### Shared + API
- [x] Shared types: intents, steer receipt/response, optional `steering` capability
- [x] DO migration 072 (`delivery_intent`, `steer_outcome`, `steer_fallback_reason`)
- [x] accept: intent persisted + idempotency includes intent + validation (no urgent steer)
- [x] claim lanes; steer bypasses busy backoff; ordered single steer per session
- [x] adapter `steer` + reconcile; runner steer path; fallback conversion; no new epoch
- [x] broadcast `mailbox.delivery_updated` with intent/outcome; persist outcome on transcript row
- [x] composer schema + send-chat; MCP tool; event subscriptions runtime_steer
- [x] Tests (sqlite unit + adapter + entry points)

### Web
- [x] Composer Steer now / Queue next while working; send intent
- [x] Delivery chips from metadata + `mailbox.delivery_updated`
- [x] Playwright screenshots 375/1280

### Docs
- [x] Public docs: chat-features (Sending a message while the agent works), api.md (Live steering), configuration (ACP_STEER_TIMEOUT), agents.md (OpenCode sam-s1, send_durable_message), acp-runtime-distribution.md (C2.3)

## Acceptance criteria

- [ ] Steer to each shipped runtime (Claude 0.81.2, Codex C2.3, OpenCode patched) during a long
      multistep turn changes a later action before the original turn completes (staging evidence)
- [x] Idle/turn-end race → queued fallback, never a detached turn (real-adapter idle steer = prompt_required for all 3; steer-lane fallback test)
- [x] Duplicate delivery ID / lost response → no duplicate injection; runtime change → ambiguous (VM steering tests; adapter receipt-recovery + steer-lane reconcile tests)
- [x] Steer acceptance does not create a prompt epoch, reset timeouts, or mark idle (steer-lane test asserts session_state unchanged; VM no-epoch test)
- [x] Old VMs / unsupported adapters → visible queued fallback (adapter test: no `steering` capability → runtime_steering_unsupported, nothing sent; chip test)
- [x] UI distinguishes Steer now / Queue next / Stop with truthful states (footer + hook + chip tests; Playwright steering-composer-audit)

## Notes / limitations log

### Real shipped-adapter evidence (2026-11-05, local, mock model, no API keys)

`packages/vm-agent/internal/acp/session_host_real_adapter_steering_test.go` (opt-in env vars)
drives each shipped build through the real `SessionHost.HandlePrompt` + `SessionHost.Steer`:

| Adapter build | Idle steer | Mid-turn steer | Steer seen by | Completions |
| --- | --- | --- | --- | --- |
| claude-agent-acp 0.81.2 + claude-code 2.1.281 | prompt_required | injected | model call 2 of 2 | 1 |
| codex-acp 2.1.1-sam-c2.3 + codex-cli 0.160.0-sam-c2.2 (CI run 41948124473) | prompt_required | injected | model call 2 of 2 | 1 |
| opencode 2.2.5-sam-s1 (CI run 41952487055) | prompt_required | injected | model call 3 of 3 (call 2 = title side request) | 1 |

The first agent-turn model call is held while the steer is sent, so the steer is
provably delivered before the original turn completes and changes the next model call.

### Later fixes found during web work (2026-11-05)
- Failed steers were never labelled on the transcript (reload would show "Steering…" forever) and the
  live `message.new` row lacked `deliveryIntent`; both fixed in 56c7d01b2 with discriminating tests.
- Steering composer audit: `apps/web/tests/playwright/steering-composer-audit.spec.ts` (12 cases,
  375/1280, dark/light); desktop label truncation fixed.

### Known limitations (for PR)
- Stock npm codex-acp 2.1.1 sessions are not steerable (visible queued fallback). Codex steering needs
  SAM's C2 runtime (`SAM_CODEX_C2_CANDIDATE=1` or Codex forms/URL interactions enabled).
- CI and workspace OpenCode builds are not byte-identical across environments; the CI build is published.
- A crash between injection and receipt write leaves the steer `ambiguous` (never replayed).
- "Added to current turn" means the runtime accepted it, not that the model acted on it.
- A checkpoint/cancel during an in-flight steer RPC may drop the steer (reported ambiguous / fallback).
- A steer that expires by TTL before delivery is not labelled on the transcript (TTL is 24h; steers claim immediately).
- UI default is "Queue next" pending product decision.

### Artifacts
- Codex runtime release: https://github.com/raphaeltm/simple-agent-manager/releases/tag/acp-codex-runtime-c2.3-codemode2
  (archive sha256 384d0071…5bd65bd, 136243963 bytes; deterministic repackage; CLI byte-identical to c2.2).
- OpenCode release: https://github.com/raphaeltm/simple-agent-manager/releases/tag/opencode-v2.2.5-sam-s1
  (two builds in one environment are byte-identical; CI vs workspace builds differ, so the CI
  build is the published artifact).
