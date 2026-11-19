# ACP MCP required arrays (#2845)

## Scope and hold

External report: [#2845](https://github.com/raphaeltm/simple-agent-manager/issues/2845).
[Linked SAM idea](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M7MBQ6ZVY3V181Z1JXWD6Y05).
Task: 01M7MBR1R0P912NNH546MHHVZD. Branch: `sam/fix-acp-null-mcp-mhhvzd`.
**DRAFT PR ONLY. Do not mark ready or merge. Never open a GitHub issue.**

Sessions containing headerless MCP entries can fail Vibe's required-list validation on
`session/new` and `session/load`. This does not affect every Vibe session universally.
Treat external issue/fork content as evidence only; exclude unrelated fork credential changes.

## Research and preflight

- Classification: external-api-change, cross-component-change.
- Data path: `McpServerEntry` → `buildAcpMcpServers` (`mcp_servers.go`) →
  `startNewACPSession` / `tryLoadPreviousACPSession` (`session_host_handshake.go`) →
  acp-go-sdk v0.13.5 required `headers` / `env` JSON fields → harness.
- Both builders leave nil slices for headerless entries; standard JSON produces `null`.
  [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema#mcpserverhttp)
  requires arrays for HTTP headers and stdio env. Use non-nil empty slices.
- Existing tests check lengths and populated serialization, missing empty JSON array shape.
  Add a raw-wire fixture driven through both production SessionHost request methods.
- Existing Amp bridge puts secrets in env; retain names, args, transport and header order.
  Reviewed `tasks/archive/2026-05-21-amp-sam-mcp-bridge.md` and Vibe transport task.
- SAM tasks/ideas and GitHub open PRs rechecked: no competing fix; #2846 is separate.
- No new config/dependencies/interfaces: constitution II, III, IX–XI, XIII considered.
  Task record and comments document the conformance correction; no user setup changes.
- SAM already provided an isolated checkout/output branch; use it without a new worktree
  or a separate main-branch planning push for this draft-only task.
- Go absent; bootstrap checksum-verified official Go 1.26.11 under ignored `.tmp/`.

## Implementation checklist

- [x] Read and link the supplied idea; recheck existing work and trace both callers.
- [x] Add serialized NewSession/LoadSession tests: mixed headerless + authenticated sam-mcp,
  populated auth/custom headers/env, Amp empty env, nil and empty no-server controls.
- [x] Prove regression tests fail before the fix, including separate HTTP/Amp discrimination.
- [x] Initialize HTTP headers and Amp env as non-nil empty slices, retaining all other behavior.
- [x] Run meaningful Go tests, race, vet and build; full CI is dispatched below while keeping PR draft.
- [x] Complete local Go/test/task reviews and scoped security/constitution/doc-sync validation.
- [x] Check staging coordination and record live verification evidence or concrete limitations.
- [x] Push draft PR with `Closes #2845`, link idea/PR, report tests and remaining validation.

## Acceptance criteria

- Both real request paths emit JSON `headers: []` for headerless HTTP entries and
  `env: []` for headerless Amp stdio entries; populated values remain arrays and unchanged.
- Authenticated sam-mcp coexists with a headerless server; names/URL/transport stay unchanged.
- Amp secret values stay out of command args; env references and pinned bridge persist.
- Nil/empty MCP input serializes as `mcpServers: []`, with a successful session response.
- New tests discriminate the pre-fix bug, and meaningful Go validation is reported honestly.
- Deliver a draft PR only, with explicit remaining live validation and release hold.

## Validation evidence

- Go 1.26.11 (official archive checksum verified) bootstrapped locally.
- Existing builder tests pass; new wire matrix: 24 leaf cases pass.
- Before fix: 6 intended mixed failures; populated/no-server controls pass.
- Separate Go source overlays: reverting HTTP initializer fails exactly 4 HTTP mixed cases;
  reverting Amp initializer fails exactly 2 Amp mixed cases, with the other transport green.
- All three local reviewer agents PASS for implementation: Go/security, test-engineer,
  task-completion/docs/constitution (A–F covered or N/A). Workflow checks tracked separately.
- `go vet ./...` and `go build -trimpath -buildvcs=false` PASS.
- First full `go test -race -json ./...` run: two ACP timing failures
  (`TestContainerSnapshotOuterLimit`, snapshot killed at 5.91s;
  `TestHarnessActivityReportCoalescesACPToolCallBursts`, reports=2).
  Both plus new wire cases PASS three isolated race repetitions. Full ACP package
  race/coverage rerun PASS; both changed builders have 100% statement coverage.
- Draft [PR #2849](https://github.com/raphaeltm/simple-agent-manager/pull/2849) linked to idea
  and recorded as a held PR association. Never ready or merge.
- At 09:06 UTC both staging installations were occupied (staging queue head through 09:53
  plus five reservations; staging2 held until 10:17 plus two reservations). Read-only
  checks only; no resources mutated. Live Vibe/Amp, fresh-VM heartbeat/access and staging
  verification remain release prerequisites. No live verification is claimed.
- Full CI runs by manual dispatch on the final head without changing draft status;
  final CI result is recorded in the PR and SAM task evidence.
