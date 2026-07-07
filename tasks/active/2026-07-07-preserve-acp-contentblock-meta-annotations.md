# Preserve ACP content-block `_meta`/`annotations` through vm-agent prompt parse + mirror

**Idea:** `01KWYF4H28MM5T679P55BMZXMT` (Hide SAM-injected prompt text from chat UI)
**Created:** 2026-07-07
**Slice:** 1 of N (foundational enabling layer)

## Problem

SAM injects instruction text (the `get_instructions` reminder, attachment context,
`systemPromptAppend`) into the first prompt turn. That text is the SAME string that is
(a) sent to the agent as model input and (b) mirrored back as the visible/persisted user
message, so users see it as chat noise.

The clean fix (per the idea) is a per-content-block origin/audience marker carried through
ACP → persistence → render, instead of inline `<sam>` tags (which react-markdown escapes to
literal visible text — verified). The ACP SDK we ship (`coder/acp-go-sdk` v0.13.5) already
supports this: `ContentBlockText` has `Meta map[string]any json:"_meta"` and
`Annotations *Annotations json:"annotations"` where `Annotations.Audience []Role` with
`Role` ∈ {"user","assistant"}.

**But our vm-agent strips it.** `parsePromptBlocks` (`internal/acp/session_host_prompt.go`)
unmarshals ONLY `{type, text}` from each prompt block and re-wraps via `acpsdk.TextBlock(text)`,
which builds `ContentBlockText{Text, Type}` — dropping any `_meta`/`annotations` before BOTH
forwarding to the agent CLI (`acpConn.Prompt`) and mirroring to the user message
(`injectUserMessageNotifications` → `UpdateUserMessage(block)`).

Until the marker survives this parse, no downstream slice (origin persistence, web collapse)
is possible. This slice fixes only that: **preserve `_meta` and `annotations` on prompt
content blocks.**

## Research findings

- `parsePromptBlocks` (`internal/acp/session_host_prompt.go:280-304`): inline anonymous struct
  reads `{ MessageID, Prompt: [{Type, Text}] }` only; builds blocks with `acpsdk.TextBlock(p.Text)`.
- `injectUserMessageNotifications` (`:306-343`): iterates the SAME `blocks`, wraps each via
  `acpsdk.UpdateUserMessage(block)`, `broadcastMessage`s to viewers (live browser stream) AND
  `MessageReporter.Enqueue`s via `ExtractMessages`. So preserving annotations in parse makes the
  live mirror broadcast carry them automatically.
- `acpConn.Prompt(promptReq.blocks)` (`:85-88`): forwards the SAME blocks to the agent CLI — so
  preservation is also a real passthrough correctness fix (today annotations never reach the CLI).
- SDK shapes (verified from `coder/acp-go-sdk` v0.13.5 `types_gen.go`):
  - `ContentBlockText{ Meta map[string]any json:"_meta,omitempty"; Annotations *Annotations json:"annotations,omitempty"; Text string; Type string }`
  - `Annotations{ Meta; Audience []Role json:"audience,omitempty"; LastModified; Priority }`
  - `Role` = `"user"` | `"assistant"` (`RoleUser`/`RoleAssistant`).
  - `TextBlock(text)` helper (`helpers.go`) sets only `{Text, Type}` → cannot preserve markers.
- Test harness exists: `mockMessageReporter`, `newTestSessionHost` (`session_host_test.go`,
  `session_host_prompt_retry_test.go`, `session_host_replay_suppress_test.go`).
- `ExtractMessages` (`message_extract.go:109-159`) extracts only text `Content` for persistence —
  it does NOT read annotations. Origin persistence is a FOLLOW-UP slice (needs a DO column), so
  this PR intentionally does NOT add an `Origin` field there (would be dead until the DO consumes it).

## Scope (this PR)

Preserve `_meta` and `annotations` on text prompt blocks in `parsePromptBlocks`, so the marker
survives to (a) the agent CLI and (b) the live user-message mirror broadcast. Nothing else.

## Explicitly OUT of scope (documented follow-ups)

1. Task-runner (TS) emitting the injected instruction as a SEPARATE marked content block (producer).
2. `ExtractMessages` + reporter + DO additive `origin` column for persisted-message tagging (so
   reload also hides it) — needs a migration.
3. Web: render the marked user-message segment collapsed with a chevron.

## Implementation checklist

- [ ] Widen `parsePromptBlocks` to unmarshal `_meta` and `annotations` per prompt block and
      construct `acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{Type, Text, Meta, Annotations}}`
      preserving them (keep skipping non-`text`/empty blocks; keep `firstTextContent`/`messageID`).
- [ ] Add a documented marker convention comment (constant) for SAM-injected blocks
      (`_meta["sam.origin"] = "system"` and/or `annotations.audience = ["assistant"]`) so producer/
      consumer follow-ups align. No behavior beyond documentation in this PR.
- [ ] Go unit tests (`session_host_prompt_test.go` or extend existing):
  - [ ] annotations present on input block → preserved on output `ContentBlock.Text.Annotations`
  - [ ] `_meta` present on input block → preserved on output `ContentBlock.Text.Meta`
  - [ ] plain text-only block still parses (regression), `firstTextContent` unchanged
  - [ ] non-text / empty-text blocks still skipped
  - [ ] mirror path: `injectUserMessageNotifications` broadcast retains annotations on the
        emitted `session/update` `UpdateUserMessage` block (capture broadcast via test host)
- [ ] `go build ./...`, `go vet ./...`, `go test ./internal/acp/...` all green.

## Acceptance criteria

- [x] A prompt block carrying `_meta`/`annotations` retains them after `parsePromptBlocks` (proven by test).
- [~] ~~The live user-message mirror broadcast carries the same `_meta`/`annotations`~~ — SUPERSEDED by
  the SDK finding (see "Outcome / key finding"). The SDK marshaler strips these outward, so the mirror
  broadcast CANNOT carry them. The test now proves the strip constraint instead
  (`TestInjectUserMessageNotifications_SDKMarshalStripsMarker`); origin propagation moves to the
  consumer slice via the vm-agent's own fields.
- [x] Existing prompt behavior is unchanged for text-only blocks (regression test green).
- [x] No new field is added to `ExtractedMessage`/reporter/DO in this PR (no dead cross-boundary wiring).

## Constraints

- **Staging deployment SKIPPED** per user instruction (other work is using staging). This is a
  `packages/vm-agent/` change that normally requires infra verification (rule 22/13/27); since that
  is skipped, the PR must be labeled `needs-human-review` and MUST NOT be self-merged.

## Outcome / key finding (in-session test surfaced an SDK limitation)

Implementing + testing this slice uncovered a blocking constraint that the earlier
struct-level research (reading `ContentBlockText`'s fields) missed:

**`acp-go-sdk` v0.13.5's `ContentBlock.MarshalJSON()` for the text variant deliberately
reconstructs the wire object as ONLY `{type, text}` — dropping `_meta` AND `annotations`.**
(`types_gen.go:1473+`; the text branch builds `nm := {type, text}` and returns it.) This is
the exact serializer used BOTH when the SDK sends a prompt to the agent CLI (`acpConn.Prompt`)
AND when it marshals `SessionNotification` blocks for the mirror broadcast.

Consequences:
- `parsePromptBlocks` READING `_meta`/`annotations` inbound works (the incoming JSON-RPC params
  are unmarshaled into our own struct — proven by test). ✅
- The marker CANNOT be carried OUTWARD on the ACP content block with this SDK: the agent CLI
  never receives it (fine — we don't need it to), and the SDK-marshaled mirror broadcast strips
  it too. ❌
- **Design correction:** the origin-tagging consumer slice must NOT rely on the ACP block's
  `_meta` surviving. It must read the inbound marker (via `parsePromptBlocks`) and propagate
  `origin` through the vm-agent's OWN mirror/persistence fields (e.g. `ExtractedMessage.Origin` +
  a distinct broadcast envelope field), then DO column + web consume that.

## What this PR ships (revised)

- `parsePromptBlocks` preserves inbound `_meta`/`annotations` (the requested foundation; makes the
  marker available in-process for the future consumer).
- Characterization tests that CODIFY the SDK stripping constraint so it cannot silently regress:
  - `TestContentBlockMarshal_DropsMetaAndAnnotations` — root cause (SDK marshaler).
  - `TestInjectUserMessageNotifications_SDKMarshalStripsMarker` — real mirror path drops it.
  These fail loudly if a future SDK bump starts preserving the fields (→ revisit whether the
  marker can ride the ACP block directly).

## Checklist status

- [x] Widen `parsePromptBlocks` to preserve `_meta`/`annotations` (inbound read).
- [~] Marker-convention constant — DEFERRED to the consumer slice (avoid an unconsumed symbol);
      convention documented here + in the idea instead.
- [x] Go unit tests: inbound preservation (3 tests) + outbound-strip characterization (2 tests).
- [x] `go build ./...`, `go vet ./internal/acp`, `go test ./internal/acp/...`, gofmt — all green.

## Follow-up slices (updated by this finding)

1. Producer: task-runner emits the injected instruction as a separate block carrying the marker
   in the JSON-RPC prompt params (`prompt[i]._meta` / `annotations.audience`).
2. Consumer: vm-agent reads the marker via `parsePromptBlocks`, sets `origin` on
   `ExtractedMessage` + a SAM-owned broadcast field (NOT the SDK block); additive DO `origin`
   column excluded from FTS/dedup.
3. Web: render the origin=system user-message segment collapsed with a chevron.

## References

- Idea `01KWYF4H28MM5T679P55BMZXMT`
- `.claude/rules/23-cross-boundary-contract-tests.md`, `.claude/rules/10-e2e-verification.md`
- ACP extensibility: https://agentclientprotocol.com/protocol/extensibility
- acp-go-sdk v0.13.5 `types_gen.go` `ContentBlock.MarshalJSON` (text variant strips `_meta`/`annotations`)
