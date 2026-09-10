# Event-Scoped Filters Must Encode Their Scope

## When This Applies

Any filter predicate, matcher, trigger gate, webhook selector, or source-specific
condition that is meant to apply only to one event type, source type, payload
variant, or lifecycle state.

## Why This Rule Exists

A GitHub trigger filter had the comment `Command prefix filter (for
issue_comment events)` but the code applied `commandPrefix` to every GitHub
event. The product UI defaulted the hidden command prefix to `/sam` and
persisted it for `issues`, `pull_request`, and `push` triggers. Those events do
not have `event.comment`, so the filter read an empty string and silently
rejected the entire non-comment event class. Production delivery audit rows held
the exact rejection reason for weeks, but the active trigger UI surfaced neither
the filter mismatch nor the zero-success condition.

## Class of Bug

A predicate whose scope comment does not match executable guard logic, silently
rejecting or accepting an entire event/source class.

## Hard Requirements

1. **Scope must be executable, not only documentary.** If a comment says a
   filter is "for X events", the predicate must branch on the explicit event or
   source discriminator (`event.event`, `sourceType`, lifecycle state, etc.).
   Do not rely on the incidental presence or absence of a payload field as the
   scope guard; missing fields can mean malformed in-scope payloads as well as
   valid out-of-scope payloads.

2. **Tests must prove both sides of the scope.** Add at least one in-scope test
   proving the filter still enforces its condition, and at least one
   out-of-scope test proving the stored filter is inert for event/source types
   where it must not apply. Use realistic payload shapes for both sides.

3. **UI serializers must share the same scope.** If a UI field is hidden or only
   meaningful for one event/source type, the submit payload builder must omit
   that field outside the same explicit scope. Hidden defaults must not be
   persisted for out-of-scope events.

4. **Presentation must not imply an inactive filter is active.** List rows,
   detail headers, summaries, and audit copy must render scoped filter values
   only when they are active for the configured event/source type.

5. **Shared predicate changes must enumerate callers.** When changing a shared
   predicate used to admit, reject, skip, retry, delete, or otherwise trigger an
   action, enumerate every caller in the task/PR and state whether the narrowed
   or widened scope changes each caller's behavior. See
   `.claude/rules/67-shared-predicates-that-trigger-actions.md`.

## Required Regression Shape

For an event-scoped webhook filter:

- a production-shaped out-of-scope payload carrying a stale stored filter value
  must continue evaluating the remaining filters and pass when those filters
  pass;
- an in-scope payload with a failing filter value must still fail with the same
  user/operator-visible reason string;
- if the UI can construct the filter config, a unit or component test must prove
  the builder does not persist hidden out-of-scope defaults.

## Process Check

Before merging a bug fix in this class, record why the stale data should be
handled at evaluation time, via migration, or both. Prefer an evaluation-time
guard when it safely self-heals persisted rows without destructive writes.
