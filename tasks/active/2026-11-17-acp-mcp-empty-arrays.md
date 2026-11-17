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
- [ ] Prove regression tests fail before the fix, including separate HTTP/Amp discrimination.
- [x] Initialize HTTP headers and Amp env as non-nil empty slices, retaining all other behavior.
- [ ] Run meaningful Go tests, race, vet and build; dispatch full CI while keeping PR draft.
- [ ] Complete local Go/test/task reviews and scoped security/constitution/doc-sync validation.
- [ ] Check staging coordination and record live verification evidence or concrete limitations.
- [ ] Push draft PR with `Closes #2845`, link idea/PR, report tests and remaining validation.

## Acceptance criteria

- Both real request paths emit JSON `headers: []` for headerless HTTP entries and
  `env: []` for headerless Amp stdio entries; populated values remain arrays and unchanged.
- Authenticated sam-mcp coexists with a headerless server; names/URL/transport stay unchanged.
- Amp secret values stay out of command args; env references and pinned bridge persist.
- Nil/empty MCP input serializes as `mcpServers: []`, with a successful session response.
- New tests discriminate the pre-fix bug, and meaningful Go validation is reported honestly.
- Deliver a draft PR only, with explicit remaining live validation and release hold.

## Validation evidence

Pending.
