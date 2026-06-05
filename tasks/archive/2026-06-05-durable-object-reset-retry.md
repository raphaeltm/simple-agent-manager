# Durable Object Reset Retry for Chat Session Loads

## Problem

Production deploys reset in-flight Durable Object RPCs with Cloudflare's transient error:

`Durable Object reset because its code was updated.`

The VM agent already classifies this exact string as transient for ACP heartbeats, but the TypeScript API side does not. The chat session detail route surfaces reset failures as `CHAT_SESSION_LOAD_FAILED` 500s and records `chat.session_detail_load_failed`; production evidence shows this is the top platform error and correlates with deploys.

## Research Findings

- `packages/vm-agent/internal/server/acp_heartbeat.go` has the existing Go precedent: `isTransientAcpHeartbeatResponse()` treats the exact Durable Object code-update reset string as retryable for 5xx ACP heartbeat responses. `acp_heartbeat_test.go` covers the exact string.
- `apps/api/src/routes/chat.ts` wraps only the route handler call sites. `getSession()` and `getMessages()` failures immediately call `recordChatSessionLoadFailure()` and return 500.
- `apps/api/src/services/project-data.ts` is the central ProjectData Durable Object service wrapper. `getStub()` calls `ensureProjectId()` once, then each exported method calls the RPC once.
- `projectDataService.getSession()` and `getMessages()` are used beyond the UI route, so a retry wrapper here protects other session read paths too. The user explicitly requires the chat session-load path and generic DO RPC retry while keeping the PR scoped.
- Task runner calls `projectDataService.linkSessionToWorkspace()`, `createAcpSession()`, and `transitionAcpSession()` from `apps/api/src/durable-objects/task-runner/state-machine.ts` and `agent-session-step.ts`; routing those through the service-level retry wrapper covers the requested task-runner DO call sites.
- `apps/api/src/durable-objects/task-runner/helpers.ts:isTransientError()` currently treats unknown errors as transient but does not explicitly match the Durable Object reset string; this is fragile and needs a regression test.
- `packages/providers/src/hetzner.ts:isTransientCapacityError()` is the local pattern for explicit classifier helpers.
- Retry values must be env-configurable per Constitution Principle XI. Add `DO_RETRY_MAX_ATTEMPTS` and `DO_RETRY_BASE_DELAY_MS` with defaults, and use these instead of inline magic values.
- Relevant process lessons:
  - `tasks/archive/2026-06-02-acp-prompt-transient-retry.md`: retry must be bounded, visible in tests, and preserve terminal/non-retryable paths.
  - `tasks/archive/2026-05-08-staging-projectdata-sqlite-migration-blocker.md`: staging deployments can fail on Durable Object migration/tag drift; inspect deployment logs and distinguish config from code.
  - `.claude/rules/13-staging-verification.md` and `.claude/rules/33-staging-feature-validation.md`: staging must exercise the actual feature, not just page loads.
  - `.claude/rules/35-vertical-slice-testing.md`: route-to-DO behavior needs realistic boundary mocks.

## Checklist

- [x] Add a TypeScript Durable Object transient classifier with explicit coverage for `Durable Object reset because its code was updated` and related reset/overload conditions.
- [x] Add unit tests for the classifier, including the exact string and case variants.
- [x] Add env-backed retry configuration to `Env` for `DO_RETRY_MAX_ATTEMPTS` and `DO_RETRY_BASE_DELAY_MS`.
- [x] Document retry configuration in `.env.example` and the public configuration reference.
- [x] Add a bounded ProjectData DO RPC retry helper that retries `getStub()`/`ensureProjectId()` and the target RPC when the classifier says the error is transient.
- [x] Apply the retry helper to `getSession()`, `getMessages()`, `linkSessionToWorkspace()`, `createAcpSession()`, and `transitionAcpSession()`.
- [x] Wire the classifier into `task-runner/helpers.ts:isTransientError()` before the default-true fallback.
- [x] Add regression tests for `isTransientError()` explicitly matching the DO reset string.
- [x] Add a behavioral route/service test where `getSession()` or `getMessages()` throws a DO-reset error on the first call, succeeds on retry, returns a successful chat session detail response, and does not record `chat.session_detail_load_failed`.
- [x] Add a retry-exhaustion test proving the error still surfaces and chat session load failure recording occurs only after retries are exhausted.
- [x] Run focused tests, then full quality gates. Focused retry/classifier/chat route tests passed: 4 files, 47 tests; API typecheck passed; API lint passed with existing warnings; full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed.
- [ ] Run specialist review: `$task-completion-validator`, `$cloudflare-specialist`, `$constitution-validator`, `$test-engineer`, and `$env-validator`.
- [ ] Deploy the branch to staging via `deploy-staging.yml`, open a chat session immediately during/after deploy, and confirm no new `chat.session_detail_load_failed` observability event for that action.
- [ ] Create PR, wait for CI, merge when green and staging verification passes, then monitor production deploy.

## Acceptance Criteria

- TS transient-DO classifier exists with unit tests covering the exact reset string and case variants.
- `getSession()` and `getMessages()` retry transient DO reset errors transparently; a behavioral test proves first-call reset then success does not produce a 500 or observability write.
- After max retries, the error still surfaces and `chat.session_detail_load_failed` is recorded only after retry exhaustion.
- `task-runner/helpers.ts:isTransientError()` explicitly matches the DO-reset string rather than relying on unknown-error fallback.
- Task-runner ProjectData DO call sites use the retry wrapper through `projectDataService`.
- Retry attempts and delays are env-configurable through `DO_RETRY_MAX_ATTEMPTS` and `DO_RETRY_BASE_DELAY_MS` with defaults.
- Staging verification exercises actual chat session detail loading during/after a deploy and checks observability for absence of a new `chat.session_detail_load_failed`.

## References

- Idea: `01KT90KPP533AKPZVG047F5MVP`
- SAM task: `01KTCP23JFYFD8ASHTCCYFNV5G`
- Related idea: `01KT6AMNHDSAV3KWDSN9G7GCQ6` (workspace-dispatch handshake, keep scoped out unless a shared helper is directly useful)
