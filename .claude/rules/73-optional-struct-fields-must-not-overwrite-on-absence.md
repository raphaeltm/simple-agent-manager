# A Zero-Valued Optional Field Must Not Overwrite Existing State

## When This Applies

Any update helper that takes an **options struct** — variadic (`opts ...fooOpts`),
pointer-optional, or a partial-patch payload — and copies its fields onto a
longer-lived record. In this repo the canonical shape is
`upsertWorkspaceRuntime(workspaceID, repository, branch, status, callbackToken string, opts ...workspaceRuntimeOpts)`
in `packages/vm-agent/internal/server/workspace_routing.go`, but the class covers
any `applyX(existing, opts)` in Go or TypeScript.

The tell is a block where most fields are guarded (`if opt.Name != "" { ... }`)
and one is not — almost always a `bool`, an `int`, or an enum, because those
types have no spare zero value to mean "not supplied".

## Why This Rule Exists

`workspaceRuntimeOpts` guarded all thirteen string fields and assigned the single
bool unconditionally:

```go
var opt workspaceRuntimeOpts   // zero value → Lightweight == false
if len(opts) > 0 { opt = opts[0] }
...
if opt.CloneURL != "" { runtime.CloneURL = opt.CloneURL }   // guarded
runtime.Lightweight = opt.Lightweight                        // NOT guarded
```

Five production call sites pass **no opts at all** — a browser opening the agent
WebSocket (`agent_ws.go:72`), two terminal WebSocket connects
(`websocket.go:196`, `:337`), and two snapshot-restore paths
(`session_snapshot.go:145`, `session_restore_retry.go:101`). Each silently
cleared the flag on an already-created workspace.

`Lightweight` is load-bearing twice. `agent_ws.go:386` gates **the only**
cf-container runtime-asset injection on it, and clears it at line 72 of the same
request — so the browser connecting to the chat was itself what destroyed the
flag. Every SessionHost built afterwards (agent restart, suspend/resume,
sleep/wake) got `RuntimeAssetsProvider == nil` and started the agent with no
project/profile/skill env vars and no runtime files. In production, an Instant
session reported `CF_TOKEN is set: no` while the project had seven
`project_runtime_env_vars` rows and a VM session for the same project had all
seven. Only the `SAMEnvFallback` set survived — the nil-provider signature.

Second consequence, on VMs: `recoverWorkspaceRuntime` passes
`state.Lightweight = runtime.Lightweight`, and all three of its callers sit
downstream of a no-opts upsert in the same handler, so a lightweight workspace
needing container recovery rebuilt as a full devcontainer.

## Class of Bug

**An optional field whose "absent" and "false" cases are indistinguishable.** The
diff that introduces it is invisible: adding one `bool` to an options struct next
to a dozen guarded strings looks uniform and reads as correct. Nothing is nil,
nothing panics, no type changes, and every call site still compiles.

It is the options-struct sibling of `.claude/rules/63` (relaxing a column deletes
the checks that used it) and `.claude/rules/71` (tightening one deletes a
capability): here, the *default* deletes state.

The tells:

- A guarded-string block with one unguarded `bool` / `int` / enum in it.
- `var opt fooOpts` followed by `if len(opts) > 0`, where the zero value is then
  copied wholesale.
- A caller that passes the options struct only to refresh a status, a token, or a
  timestamp.
- A PATCH/merge helper that does `Object.assign(existing, patch)` on a payload
  whose optional keys may be absent.

## Hard Requirements

1. **Give every optional non-string field a representation for "not supplied."**
   A pointer (`*bool`), a discriminated `{set: true, value: …}`, or an explicit
   `undefined` in TypeScript. Do **not** guard with `if opt.Flag { ... }` — that
   compiles, silences the symptom, and makes the field permanently unsettable to
   false, which is a different bug in the other direction.

2. **Enumerate every caller before adding or changing an optional field**, and
   state per caller whether it intends to set that field (`.claude/rules/44`).
   Callers that pass no options at all are the dangerous ones precisely because
   they do not appear in a grep for the field name.

3. **Audit the whole update block, not just the field you came for.** Mixed
   guarded/unguarded assignments in one block mean the convention is already
   ambiguous; list every field and its guard in the PR.

4. **Say what the default means, in the struct's doc comment.** "Zero value means
   not supplied" is a contract the next field-adder needs to read before they add
   a bool.

5. **Prefer a compile-time-checked change.** Widening `bool` to `*bool` makes the
   compiler enumerate the call sites for you. A runtime `hasOpts` flag does not,
   and leaves the next caller free to reintroduce the bug.

## Required Tests

- **One case per no-opts call site**, as a table: set the field, run the caller's
  exact upsert shape, assert the field survived. Naming each case after its call
  site is what makes a future deletion visible.
- **A liveness assertion inside each case** (`.claude/rules/62`): assert a field
  the caller *did* supply was applied, so a passing test cannot mean the update
  became a no-op.
- **An explicit-override control**: the field must still be settable to its zero
  value on purpose, in both directions.
- **The downstream consumer, not just the flag.** Assert the thing the flag gates
  — here, that a standalone SessionHost built after the WebSocket upsert reports
  `HasRuntimeAssetsProvider() == true`. A flag test alone would have passed if the
  gate were later rewired to a different field.
- **A control on the other side of the gate** (`.claude/rules/61`): the VM path
  must NOT get the standalone provider, so "always wire it" cannot pass.
- **Proven discriminating.** Restore the unguarded assignment alone — keeping the
  new type so the build still succeeds — and confirm exactly the intended tests go
  red while the controls stay green. Record which tests went red in the PR.

## Quick Compliance Check

- [ ] Every optional non-string field can express "not supplied"
- [ ] No guard of the form `if opt.Flag { ... }` was used to fix an absence bug
- [ ] Every caller is enumerated, including those passing no options
- [ ] The whole update block was audited for other unguarded fields
- [ ] The struct's doc comment states what the zero value means
- [ ] Per-call-site tests exist, each with a liveness assertion
- [ ] An explicit-override control proves the field is still writable both ways
- [ ] A test asserts the downstream consumer, plus a control for the other runtime
- [ ] The pair was verified discriminating against the pre-fix assignment

## References

- Implementation: `packages/vm-agent/internal/server/workspace_routing.go`
  (`workspaceRuntimeOpts.Lightweight`, `lightweightOpt`)
- Tests: `packages/vm-agent/internal/server/workspace_runtime_lightweight_test.go`
- Idea `01M25DNSF1A5B8Z6VV29ZX1AT7`
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md` — the schema sibling
- `.claude/rules/71-tightening-a-column-can-delete-a-capability.md` — the mirror image
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every caller
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — prove the guard discriminating
- `.claude/rules/61-guards-must-cover-every-runtime.md` — one guard, every runtime
