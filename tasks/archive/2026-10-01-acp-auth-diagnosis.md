# ACP Slice D: isolated authentication diagnosis

## Problem

Session failures need to distinguish agent credential problems, MCP endpoint authentication, unsupported local callback flows, and model access failures. A generic credential prompt can mislead a user whose account cannot use the selected model.

## Research

- Approved v2 plan: SAM Idea `01M3P2E0JJNQRXX020P65ZRKEJ`.
- `packages/shared/src/failure-classification.ts` already classifies task failure text and drives the real chat `FailureCard`.
- `SettingsConnections` is `/settings/connections`; personal `SettingsMcpServers` is `/settings/mcp-servers`.
- C2 draft #2207 owns URL bridge/contracts; activation draft #2204 owns flags. Neither belongs in this slice.
- The real chat failure card receives `session.isMine`, so personal settings actions can be restricted to the creator.

## Checklist

- [x] Add narrow auth and model-availability classifications with conservative negative cases.
- [x] Emit safe structural reason codes for recognized VM agent-key and prompt auth failures.
- [x] Show existing settings actions in the real chat failure card only for the session creator.
- [x] Add unit tests for cross-provider distinctions, role restrictions, and static guidance with secret canaries.
- [x] Add real-chat Playwright click tests on mobile and desktop and personally inspect screenshots.
- [x] Update public agent/MCP troubleshooting guidance.
- [x] Finish full checks and specialist validation.
- [x] Create draft PR [#2209](https://github.com/raphaeltm/simple-agent-manager/pull/2209) and send exact handoff evidence to coordinator before staging.
- [x] Add real-chat consumer for an exact, fixed loopback system diagnostic with creator-gated existing MCP settings guidance and retry/spoof tests.
- [x] In an isolated code-only integration branch after explicit C2 freeze release, combine frozen C2 and reviewed D, then report explicit loopback-only URL rejection as a fixed system diagnostic through the existing MessageReporter.
- [x] Parent-owned coordinated staging and live runtime matrix after the integration candidate is reviewed; no D staging or production mutation here.

## Acceptance / limits

This slice diagnoses recognized task error reasons and displays static guidance. It adds no new API/event shape, does not change C2 URL data, activate interactions, perform provider login in a session, or assert a remote service's authentication succeeds. The coordinator owns final runtime/harness validation and staging slot.

The VM only identifies a missing connection when the existing agent-key endpoint returns its exact `NOT_FOUND` / `Agent credential not found` response. Workspace 404 and malformed/empty 200 responses remain generic. MCP and loopback reason codes require a structural source; arbitrary MCP 401 or localhost text in an ACP error is deliberately not promoted to an auth diagnosis. Slice D owns the narrow loopback producer integration after C2's frozen slot; no MCP producer is justified by the currently reviewed ACP wire shape.

For provider failures, the VM reads the pinned ACP SDK's top-level `RequestError` (`-32603`, `Internal error`) and the pinned Claude adapter's categorical `Data.errorKind`; it emits only a bounded reason code. Claude `authentication_failed` means rejected provider credentials and `model_not_found` means unavailable model; ambiguous categories remain generic. Adjacent tests cover SDK error → prompt broadcast, callback sanitization, shared classification, and the real chat. The pinned Codex adapter holds MCP `reauthenticationRequired` internally but forwards only failed tool-call text over ACP, so SAM has no trusted MCP auth signal on the wire; this slice does not infer MCP auth from that prose. Existing GPT-6.1 provider HTTP 400 unsupported-model evidence after successful ACP selection is model availability, not credential failure.

Review correction: the missing-connection startup banner remains visible when the same selection failure has set `task.errorMessage`. It requires the exact VM-authored `system` transcript message; assistant/tool content cannot trigger it. The exact `agent_prompt_failed` task reason shows retry/debug guidance without suggesting a credential change, including when unrelated execution-step text mentions authentication.

Provenance and current limit: the VM's `ExtractMessages` maps ACP agent updates to assistant/thinking/plan/tool (and user chunks to user), never `system`; the static startup diagnostic is enqueued by `persistAgentSelectionFailure` through the authenticated workspace-message callback. The banner survives unrelated system rows, and a later successful retry turn (user/assistant messages) clears it. The shared classifier now accepts new auth/model guidance only from exact task reason codes, not free-text `Provider`, `API Error`, URL, schema, or message fields. Pinned Go SDK `RequestError.Error()` serializes untrusted `Data`; wire-decoded tests cover Claude `errorKind=authentication_failed`, Codex configured turn `codexErrorInfo=unauthorized`, and generic MCP 401 / unsupported 400 without a trustworthy model source through the prompt-completion and HTTP task-callback seams. The Codex adapter's non-auth bad-request path currently yields agent text rather than a categorical prompt error, so this slice does not claim live GPT-6.1 unsupported-model classification. These remain deterministic wire-shape tests, not live adapter/account validation.

Pinned source boundary: [Claude adapter v0.81.2 `errorKindData`](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.81.2/src/acp-agent.ts#L9213-L9225) returns `{errorKind}` for `RequestError.internalError`; its [failure mapping](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.81.2/src/session-failure-extension.ts#L449-L478) distinguishes `authentication_failed` from `model_not_found`. It does **not** establish `Data.error`. [Codex adapter v1.13.1](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexEventHandler.ts#L1387-L1405) uses `{message,codexErrorInfo?,additionalDetails?}` for turn errors. Codex sees [MCP `reauthenticationRequired` internally](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexAcpServer.ts#L2475-L2513) but [forwards failed startup as tool-call text](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexEventHandler.ts#L1093-L1114), without that structural reason. SDK-shaped deterministic tests are not live pinned-wrapper or provider-account validation.

Post-C2 additive hook: when an enabled, well-formed `requestURL` is rejected by C2 eligibility solely for an explicit loopback callback host (direct URL or C2-listed callback/redirect query key, within C2's existing size/depth bounds), enqueue one fixed system diagnostic through the existing `MessageReporter` and authenticated CF workspace-message route. Never copy the URL, query, token, or wrapper metadata into diagnostics. Ineligible non-loopback URLs, malformed requests, disabled interactions, and stale prompt attempts stay generic. No new API, token custody, or login lifecycle is needed. The parent released the C2 code freeze for this isolated integration branch only; C2 staging and both reviewed draft heads remain untouched.

The chat consumer recognizes only the fixed VM-authored system text `This sign-in flow requires a local callback that this session cannot complete.` It shows a creator-only link to existing MCP settings, asks other members to contact the creator, and clears after a later user or assistant turn. Assistant/tool text and unrelated system rows cannot synthesize the banner. The isolated integration producer reuses that exact text after all non-URL request guards and active generation/prompt checks pass. A pinned ACP SDK fixture verifies the URL request is canceled and only the fixed system message reaches MessageReporter; it does not claim live adapter/account validation or a completed remote authentication flow.

Review correction: the legacy display classifier no longer infers `credentials` from combined free-text message and execution step. URL query text, schema fields, Provider 401 prose, and `unauthorized` step text stay generic unless the task carries an exact trusted reason code. Historical untyped auth/billing prose can therefore fall back to general investigation guidance; that tradeoff avoids prescribing credential changes without provenance.

Parent-owned final runtime matrix: exact agent-credential 404 versus workspace 404; real Claude `authentication_failed` and `model_not_found` when reproducible; actual Codex GPT-6.1 unsupported-model HTTP 400 after successful ACP selection; MCP auth failure remaining generic without a trusted ACP source; accepted C2 HTTPS URL versus explicit loopback callback; creator/member desktop and mobile settings navigation; canary absence from callback, logs, events, and transcript; retry after updating a connection; cross-project authorization. Distinguish fixture results from real provider-account outcomes.

## Verification

- Isolated C2+D integration: pinned acp-go-sdk URL request fixture returns cancel for a loopback URL and enqueues only the fixed system text. Direct and C2-listed nested callback hosts classify separately from malformed, non-loopback, over-length/depth, oversized encoded, disabled, stale-generation, inactive-prompt, canceled-request, and wrapper-metadata cases. No rejected URL reaches the Worker create path. Full VM-agent Go suite and focused ACP race tests passed locally.
- The loopback diagnostic reserves its fixed entry only while the exact prompt attempt, generation, URL feature configuration, and request context are active. The structural user-message ID is set during attempt construction before publication for server/control-plane prompt paths; untrusted viewer prompts receive no attribution. Reporter persistence occurs after releasing prompt/interaction locks; a slow reporter may finish after that prompt settles, but cannot hold up cancellation or a subsequent prompt. The entry carries only the bounded control-plane prompt's structural user-message ID in existing tool metadata. The UI resolves that ID to a same-session persisted user row and suppresses a late diagnostic after a later user/assistant turn, independent of reporter arrival order, millisecond ties, or VM/Worker clock skew; missing, malformed, or paged-out anchors fail closed, so guidance can be suppressed rather than misattributed. Deterministic admission, same-generation A→B, late cancellation, blocked-reporter, Reporter HTTP transport, authenticated Worker callback and Durable Object metadata persistence, merge-order unit, and late-arrival browser tests cover this ordering.
- Combined shared tests: 771 passed. C2 callback/delivery API tests: 74 passed; focused Worker interaction-store tests: 12 passed. Combined web build/typecheck and docs build passed. Real chat plus C2 URL desktop/iPhone SE Playwright: 34 passed, 10 existing skips; integration screenshots personally inspected for guidance visibility and overflow. No live pinned wrapper/account or staging runtime matrix is claimed.

- Shared failure-classification tests: 59 passed on reviewed D. Web failure-card tests: 22 passed. VM agent `go test ./...` and local mock/Worker VM smoke passed; focused SDK callback, prompt broadcast, and credential tests passed after final edits. Smoke fixtures now use the current API error envelope and fixed reason code.
- Root lint, typecheck, and build passed. Root test had three API timeouts under parallel load; the exact three files passed on isolated rerun (104 tests).
- Real-chat Playwright includes creator/member restrictions, actual settings navigation, trailing-status persistence, assistant/tool spoof negatives, generic prompt guidance, and clearing after a new turn across phone, tablet, and desktop viewports. The final review-correction run passed 18 desktop/iPhone SE cases. Reviewed screenshots are under `tasks/evidence/acp-slice-d/`.
- Security/Go, UI/docs, constitution, and task-completion reviews found no remaining blocker.


## Parent integration evidence — 2026-10-03

The original child-task draft/no-deploy constraints above describe that handoff.
The parent owns the subsequently authorized readiness, merge and production
release. Integrated PR #2217 includes these changes; the current evidence and
remaining release steps are in `scripts/diagnostics/acp-runtime-distribution.md`.
Full integrated CI `37121769606` and staged head `e27c4d092` passed. Live VM
permissions, form and both URL completion orders passed; Instant Claude
permissions, Codex form/URL same-turn continuation, actual candidate executable
selection and fresh-stock GPT-5.5 rollback now have distinct live evidence.
Timeout/interruption and unsupported-model attempts remain explicitly excluded
from successful continuation claims. No new provider login or token custody was
added. Final rollback and release disposition remain parent-owned.
