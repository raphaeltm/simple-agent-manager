# Amp Project Chat MCP Wiring

## Problem

Amp direct project-chat sessions must receive SAM MCP configuration before ACP `NewSession` starts. Prior staging evidence only proved Amp can install/start and reach the ACP lifecycle; it did not prove Amp called SAM MCP tools during a direct project-chat run. The integration is not complete until staging evidence shows Amp using at least one SAM MCP tool and using the result in its chat response.

This task is being handled through the `/do` workflow.

## Research Findings

- `apps/api/src/routes/workspaces/agent-sessions.ts` creates direct project-chat agent sessions and calls `createAgentSessionOnNode(...)` with only `sessionId`, `label`, `chatSessionId`, and `projectId`.
- `apps/api/src/services/node-agent.ts` supports sending MCP server config only through `startAgentSessionOnNode(...)`, which task-driven agents call, but direct project-chat sessions do not.
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts` mints an MCP token with `generateMcpToken()` / `storeMcpToken()`, uses `https://api.${BASE_DOMAIN}/mcp`, and passes it to `startAgentSessionOnNode(...)`.
- `packages/vm-agent/internal/server/workspaces.go` validates and persists `mcpServers` only in `handleStartAgentSession(...)`; `handleCreateAgentSession(...)` currently does not accept MCP config.
- `packages/vm-agent/internal/server/agent_ws.go` creates the ACP `SessionHost` on WebSocket attach and reads MCP config from `sessionMcpServers` or persisted SQLite before `SelectAgent` can call ACP `NewSession`.
- `packages/vm-agent/internal/acp/session_host_handshake.go` passes `buildAcpMcpServers(h.config.McpServers)` into both `LoadSession` and `NewSession`.
- `packages/vm-agent/internal/acp/mcp_servers_test.go` already covers ACP wire formatting for `sam-mcp` once config reaches the host.
- Relevant postmortems:
  - `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`: component-level contracts are insufficient unless the full user-to-agent path is verified.
  - `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`: MCP token lifetime must match ACP session lifetime.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: live chat state must use the canonical chat-scoped session identity, not workspace-level heuristics.

## Implementation Checklist

- [x] Re-read `.do-state.md` before each phase transition and keep it current.
- [x] Create a dedicated worktree for `sam/use-command-workflow-handle-01ks2x`.
- [x] Move this task file from `tasks/backlog/` to `tasks/active/` in the worktree.
- [x] Add API/control-plane wiring so direct project-chat session creation mints a SAM MCP token and sends `https://api.<BASE_DOMAIN>/mcp` plus the token to the VM before ACP startup.
- [x] Ensure the direct project-chat MCP token is scoped to the correct user, project, workspace, chat session, and agent session, and does not leak in logs.
- [x] Extend VM agent create-session handling, if needed, so MCP config sent during session creation is validated, persisted, and available before WebSocket `select_agent` triggers ACP `NewSession`.
- [x] Add focused API/control-plane coverage proving direct project-chat session creation supplies SAM MCP config.
- [x] Add VM agent coverage proving create-session MCP config is persisted and later injected into the ACP host before `NewSession`, if the VM create endpoint changes.
- [x] Run focused tests for the modified API and VM paths.
- [x] Run required quality gates before PR.
- [x] Complete required specialist reviews: task-completion-validator, cloudflare-specialist, security-auditor, constitution-validator, test-engineer, and go-specialist if VM Go changes are made.
- [x] Deploy the PR branch to staging via `gh workflow run deploy-staging.yml --ref sam/use-command-workflow-handle-01ks2x`.
- [x] Verify staging on a fresh workspace/node with the primary staging smoke-test user and valid Amp credential.
- [x] Add opt-in staging smoke verification for the live Amp project-chat SAM MCP run.
- [x] Collect PR evidence: staging deploy URL, timestamp, user/project/workspace/node/agent-session/chat-session IDs, summarized D1 state, debug-package log excerpts, and explicit SAM MCP tool-call evidence with no secret values.
- [ ] Merge only if `/do`, CI, staging, credential, and project policies all allow it.

## Acceptance Criteria

- Direct project-chat agent session creation provides a valid SAM MCP server config before ACP startup.
- The MCP URL is `https://api.<BASE_DOMAIN>/mcp`.
- MCP token metadata preserves security boundaries for user, project, workspace, chat session, and agent session.
- Tokens are not printed in application or VM logs.
- Automated tests prove the direct project-chat wiring path and any VM persistence/injection changes.
- Staging deploy for the PR branch passes through the normal GitHub Actions pipeline.
- Staging verification uses a fresh workspace/node and the primary smoke-test user with the active Amp credential.
- Amp installs and starts with `acp-amp` and `@sourcegraph/amp` present.
- `AMP_API_KEY` is injected without printing the secret.
- ACP `NewSession` includes a `sam-mcp` MCP server config.
- Logs, telemetry, or chat events prove Amp called at least one SAM MCP tool.
- The MCP tool result influences Amp's project-chat response, which references real repo/project facts.
- The session reaches a sane terminal state and is not left stuck `running`.
- No Amp API 401/403, missing credits, missing CLI, missing npm, or missing key errors occur.
- If staging fails, the PR classifies the failure as platform bug, external credential/credits issue, or infrastructure bug and does not merge unless policy permits.

## Validation Notes

- Focused API coverage passed after adding route-level wiring coverage: `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/agent-sessions-mcp.test.ts tests/unit/node-agent-contract.test.ts tests/unit/routes/mcp.test.ts` (`266/266` passed).
- API typecheck passed: `pnpm --filter @simple-agent-manager/api typecheck`.
- API lint passed with existing warnings only: `pnpm --filter @simple-agent-manager/api lint`.
- Broader pre-review validation already completed: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `go test ./...` in `packages/vm-agent`, and focused VM tests.
- Full `pnpm test` completed but hit unrelated API timeout failures; the six failing files passed when rerun directly (`39/39` passed).
- First PR-branch staging deploy passed through the normal pipeline: `https://github.com/raphaeltm/simple-agent-manager/actions/runs/26171873932`, head SHA `4fb740477b4024f76d4183b2c2b0ce321df55387`.
- Added opt-in live smoke test `tests/smoke/amp-project-chat-mcp.spec.ts`, enabled only with `AMP_PROJECT_CHAT_MCP_SMOKE=true`, plus `deploy-staging.yml` manual-dispatch input `amp_project_chat_mcp_smoke`.
- Repo typecheck passed after adding the smoke verifier: `pnpm typecheck`.
- Repo lint passed after adding the smoke verifier with existing warnings only: `pnpm lint`.
- Local Playwright skipped-mode check passed via CLI script after mirroring the workflow's root Playwright symlink setup: `node node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/cli.js test --config=tests/smoke/playwright.config.ts tests/smoke/amp-project-chat-mcp.spec.ts` (`1 skipped`).
- Live smoke run `https://github.com/raphaeltm/simple-agent-manager/actions/runs/26173064893` deployed staging successfully but failed in the verifier, before collecting debug evidence. The failure was a smoke-test instrumentation bug: the verifier asserted on WebSocket text that only contained `available_commands_update` plus the echoed `user_message_chunk`, not assistant/tool output.
- Updated the live smoke verifier to parse ACP updates like the UI (`agent_message_chunk`, `tool_call`, `tool_call_update`), wait for `session_prompt_done`, poll persisted project chat for project facts plus exact SAM MCP tool indicators, disable retries for this expensive live test, and then check debug-package evidence.
- Post-fix validation passed: `pnpm typecheck`; local Playwright skipped-mode check (`1 skipped`).
- Live smoke rerun `https://github.com/raphaeltm/simple-agent-manager/actions/runs/26174155779` deployed staging successfully but failed with persisted project-chat text `Error: Process exited with code 1` for fresh workspace `01KS322854PZR52GD2DHB82JED` and chat session `0dd6a1d3-d79c-4940-8427-6f5665126951`. The verifier still asserted before emitting debug-package evidence, so this failure is not yet classified as platform, external credential/credits, or infrastructure.
- Updated the live smoke verifier again so it logs sanitized `AMP_PROJECT_CHAT_MCP_EVIDENCE` before assertions and returns early when persisted chat shows terminal Amp/bootstrap errors. The next PR-branch staging run should provide debug-package evidence needed to classify the Amp exit.
- Post-update validation passed: `pnpm typecheck`; local Playwright skipped-mode check (`1 skipped`).
- Live smoke rerun `https://github.com/raphaeltm/simple-agent-manager/actions/runs/26175270000` deployed staging successfully but failed before Amp startup because fresh node provisioning hit `[hetzner] hetzner API error (403): server limit reached`. Staging D1 showed failed node `01KS33B83R2E0B3KXV4BQVC3PV` with no workspace row, plus three prior `Amp MCP` smoke nodes still `running` (`01KS3228074WXMY70CRJBZT008`, `01KS316NBNF2TEB54AJSBV90VN`, `01KS30Y2H7KRBYN9KZ9EGD8MFQ`). Classification: infrastructure capacity/cleanup failure, not an Amp MCP result.
- Updated the live smoke verifier to delete stale `Amp MCP` smoke nodes before provisioning and to delete the created node in `finally`, so failed live runs do not consume staging provider capacity.
- Post-cleanup validation passed: `pnpm typecheck`; local Playwright skipped-mode check (`1 skipped`).
- Live smoke rerun `https://github.com/raphaeltm/simple-agent-manager/actions/runs/26176083492` deployed the PR branch successfully at head SHA `7ebe7ff66301a622e9821e0b6cf86b1fe9b1a8dc`, then ran the opt-in Amp project-chat MCP smoke at `2026-05-20T16:41:27.825Z`.
- Latest staging IDs: smoke user `toWzGjNW3IyUkCVItRQv3qSn0wI8c22y`; project `01KK1D324YTB3TF5FCWAPDE3T0` (`CrewAI Org`, repo `tmp-srv-prs-org/crewai`); node `01KS346WTBRW38CXN03Q76RDFQ`; workspace `01KS346WZ38WERSA89EM1D8E1K`; chat session `64f5492b-e7b9-4472-bea3-f8b8059ac487`; agent session `01KS34HK46D7HBWKGZFNVTSEN7`.
- Debug-package excerpts from the smoke evidence showed `MCP servers registered for agent session` with `count=1`, `SessionHost created` with `mcpServers=1`, `Agent binary not found in container, installing` for `acp-amp`, `Agent binary installed successfully`, `ACP agent process started`, `ACP: sending NewSession request`, and `ACP: NewSession succeeded` with `sessionID=amp-0`.
- The same smoke evidence showed `ampToolNames=""`, `samMcpIndicators=""`, and persisted chat content `Error: Process exited with code 1`; it did not show an Amp API 401/403, missing credits, missing key, missing npm, or missing CLI error.
- Classification: platform bug. SAM now supplies MCP config before ACP startup, but direct project-chat Amp did not call any SAM MCP tool and exited with code 1 after ACP `NewSession`; therefore the full Amp integration acceptance criteria are not met and the PR must not be merged.
- Post-run D1 summary: querying the fresh node/workspace/agent-session IDs returned no rows after cleanup, and querying `Amp MCP %` nodes for the smoke user returned no rows, confirming the live smoke cleanup path removed the test resources.
- Current-head live smoke rerun `https://github.com/raphaeltm/simple-agent-manager/actions/runs/26177181050` deployed staging successfully at head SHA `c10aebb7e57f3da67ce18979d98eb40ac499e69b`, then failed the opt-in Amp project-chat MCP smoke at `2026-05-20T17:02:17.230Z`.
- Current-head staging IDs: smoke user `toWzGjNW3IyUkCVItRQv3qSn0wI8c22y`; project `01KK1D324YTB3TF5FCWAPDE3T0` (`CrewAI Org`, repo `tmp-srv-prs-org/crewai`); node `01KS35D1AH5XK5XA15V3BY1W2K`; workspace `01KS35D1F913BNT134KRR04CYV`; chat session `be8e8cb3-b865-42b8-9a18-1b122cf013cc`; agent session `01KS35RM5JQ0G8YZHSKE0N28VH`.
- Current-head debug-package excerpts again showed `MCP servers registered for agent session` with `count=1`, `SessionHost created` with `mcpServers=1`, `acp-amp` installed successfully, `ACP agent process started`, and `ACP: NewSession succeeded` with `sessionID=amp-0`.
- Current-head failure evidence again showed `ampToolNames=""`, `samMcpIndicators=""`, and persisted chat content `Error: Process exited with code 1`. No Amp API 401/403, missing credits, missing key, missing npm, or missing CLI error was shown. The classification remains platform bug and the PR remains not mergeable.
- Current-head post-run D1 summary: querying node `01KS35D1AH5XK5XA15V3BY1W2K`, workspace `01KS35D1F913BNT134KRR04CYV`, and agent session `01KS35RM5JQ0G8YZHSKE0N28VH` returned no rows after cleanup; querying `Amp MCP %` nodes for the smoke user also returned no rows.

## Specialist Review Notes

- `$task-completion-validator`: PASS for implemented pre-staging scope. Research findings map to checklist items and diff coverage. Remaining staging acceptance criteria intentionally remain open until PR-branch staging verification.
- `$security-auditor`: PASS. MCP token is opaque, scoped with user/project/workspace/chat/agent IDs, stored in KV with existing configurable TTL, and not logged. VM logs only workspace/session/count for MCP registration.
- `$cloudflare-specialist`: PASS. Uses existing KV token lifecycle and D1 control-plane access patterns; no wrangler/manual deploy path introduced.
- `$constitution-validator`: PASS. Internal MCP URL derives from `BASE_DOMAIN`; token TTL remains environment-configurable; no new hardcoded internal deployment URL or timeout/limit.
- `$test-engineer`: PASS after adding route-level control-plane coverage. Tests now cover helper token metadata, route-to-node payload propagation, shared contract schema, MCP `get_instructions`, and VM MCP persistence.
- `$go-specialist`: PASS. VM change is scoped to request decoding/validation/persistence, preserves auth gate, avoids token logging, and is covered by Go tests.

## References

- `apps/api/src/routes/workspaces/agent-sessions.ts`
- `apps/api/src/services/node-agent.ts`
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- `apps/api/src/services/mcp-token.ts`
- `packages/vm-agent/internal/server/workspaces.go`
- `packages/vm-agent/internal/server/agent_ws.go`
- `packages/vm-agent/internal/acp/session_host.go`
- `packages/vm-agent/internal/acp/session_host_handshake.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/acp/mcp_servers_test.go`
- `tests/smoke/amp-agent.spec.ts`
