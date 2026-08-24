# An Ownership Handoff Must Record That It Happened

## When This Applies

Any code path that **moves ownership of a live thing from one record to another**:
a session moving to a replacement task, a lease moving to a new holder, a workspace
re-pointed at a different node, a claim reassigned, a subscription migrated.

The tell is a transaction that *binds the new owner* and *un-binds the old one* —
typically by nulling a foreign key — and then stops.

## Why This Rule Exists

`createRecoveryTask` (`apps/api/src/services/session-recovery.ts`) commits a session
wake as one transactional D1 batch of five statements. It mints a successor task,
nulls `tasks.chat_session_id` on the previous owner, nulls
`workspaces.chat_session_id`, binds the session to the successor, and writes a status
event **for the successor**.

Nothing recorded what happened to the predecessor. It was left `in_progress`, chat-
unbound, with a workspace about to be deleted — which is byte-for-byte the state
`scheduled/stuck-tasks.ts` reads as "the runtime is conclusively gone". So the sweep
failed it, on average ~24 minutes later, **while the conversation it belonged to was
alive and running in its successor**.

In `sam-prod` over nine days, 61 of 91 `conclusively gone (workspace_deleted)` kills
were this. One traced case: the successor was created at 08:14:40.862, delegated to a
new workspace at 08:14:47, and was still running — while its predecessor was marked
`failed` at 08:15:30, fifty seconds after its own wake succeeded.

The damage was not cosmetic. `sourceTaskGuardCondition` requires the source task to be
**non-terminal**, and a guard is supplied for every `parent_wakeup` delivery. So each
false failure permanently revoked the durable parent-wake path for that conversation —
all 34 production roots with recovery children were `failed`. The visible symptom was
"the session didn't wake from the queued prompt, but resending manually woke it":
manual follow-ups are unguarded and still worked.

Two aggravating details, both worth recognising on sight:

- The same handoff nulled `workspaces.chat_session_id`, which is the exact column
  `needsSessionResumabilityProbe` is gated on. The existing rule-58 safety escape was
  therefore structurally unreachable for precisely the tasks it existed to protect —
  `.claude/rules/63` at the handoff layer rather than the migration layer.
- Successors point at the **root**, not the immediate predecessor
  (`guard ?? sourceTask.recoverySourceTaskId ?? sourceTask.id`), so a direct-child
  lineage check would have missed 36 of the 61 cases.

## Class of Bug

**An ownership transfer that leaves the former owner indistinguishable from a corpse.**

Every individual statement is correct. The new owner is right, the un-binding is right,
the transaction is atomic. The defect is an *absence*: no record that this record was
superseded rather than orphaned. Downstream reapers cannot tell the difference, and
they are built to assume the worst.

Tells:

- A transaction that sets a new owner and nulls the old owner's link, with no status
  transition and no marker on the old row.
- A successor row that gets a status event while the predecessor gets none.
- A sweep, reaper, or classifier that reads exactly the columns the handoff just nulled.
- A lineage pointer that collapses to a root, so "who replaced me" is not answerable
  from the replaced row.

## Hard Requirements

1. **The handoff must record the supersession on the record being replaced** — a
   status transition, a `superseded_by` pointer, or an explicit marker — in the **same
   transaction** that transfers ownership. "The new owner exists" is not a record that
   the old one was retired.

2. **Enumerate every consumer of every column the handoff nulls**, and state per
   consumer whether nulling it changes that consumer's verdict
   (`.claude/rules/44`, `.claude/rules/63`). A guard gated on a column your handoff
   clears is a guard you have silently deleted.

3. **A reaper must be able to distinguish "superseded" from "dead" without inferring
   it.** If the only way to tell them apart is a heuristic over timestamps or lineage
   joins, the handoff did not record enough.

4. **Check the terminal-state predicates before choosing the marker.** Marking the
   predecessor terminal is the obvious move and is often *wrong*: here every
   guarded-wake predicate required the source task to be non-terminal, so the intuitive
   fix would have broken more than it repaired. Read the predicates that consume the
   status before you write to it.

5. **Lineage must answer "who replaced me", not only "what root am I under".** A
   pointer that collapses to a root cannot express supersession of a middle link.

## Required Tests

- **The incident**: perform a real handoff, then run the real reaper against the
  predecessor. Assert it is not terminalized. Must fail against pre-fix code.
- **The discriminating control**: an equivalent record with no live successor still
  terminalizes. Without it the suite passes with reaping disabled outright.
- **The middle link**: a record superseded by a sibling that points past it to the
  root. Prove a direct-child check is insufficient.
- **Directionality**: an older sibling must never count as superseding a newer record.
- **Bounded escape** (`.claude/rules/47`): once the successor is terminal the
  predecessor leaves the candidate set.
- **Fail-safe**: make the lineage lookup throw and assert the reaper withholds its
  terminal verdict.
- **Both runtimes** (`.claude/rules/61`) if more than one reaper exists.

## Quick Compliance Check

- [ ] The handoff records supersession on the replaced record, in the same transaction
- [ ] Every column the handoff nulls is enumerated against its consumers
- [ ] Reapers can tell "superseded" from "dead" without heuristics
- [ ] The chosen marker was checked against every predicate that reads that column
- [ ] Lineage answers "who replaced me", not just "what root am I under"
- [ ] Incident + control + middle-link + directionality + escape + fail-safe tests exist
- [ ] The incident test was verified to fail on pre-fix code

## References

- Task: `tasks/active/2026-08-24-superseded-task-killed-after-successful-wake.md`
  (moves to `tasks/archive/` on completion)
- Implementation: `apps/api/src/services/task-runtime-liveness.ts`
  (`loadTaskSupersession`, `needsTaskSupersessionProbe`, `supersessionVerdict`)
- Follow-up idea: `01M0SG7ZEE1XARK4QDG7V6HDPN`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` — the destroyer must
  read the record the resumer reads; this rule is its ownership-transfer sibling
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md` — nulling a column
  deletes every check that used it
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every path
- `.claude/rules/47-control-loop-io-budget.md` — bounded escape for every candidate
- `.claude/rules/61-guards-must-cover-every-runtime.md` — one guard, every reaper
