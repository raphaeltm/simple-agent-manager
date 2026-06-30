# Durable Objects Do Not Serialize Across `await` — Use a Real Mutex for Critical Sections

## When This Applies

This rule applies to any Durable Object method that performs a **read →
external call → write** (or any check-then-act) critical section that must not
interleave with a concurrent invocation of the same DO instance. The canonical
example is `CodexRefreshLock` (`apps/api/src/durable-objects/codex-refresh-lock.ts`):
it reads a stored OAuth credential, POSTs the `refresh_token` to OpenAI, then
writes the rotated token back.

## Why This Rule Exists

A common and WRONG mental model is "a Durable Object is single-threaded, so only
one request runs at a time, so I don't need a lock." This is only true *between*
`await` points. The moment a handler `await`s an external `fetch()` (or any
async I/O), the DO is free to start processing the next queued request. Two
concurrent `async fetch()` handlers in the **same** DO instance interleave
across their `await` boundaries.

`CodexRefreshLock` relied on this false guarantee (its doc comment literally
claimed "single-threaded execution model guarantees only one request is
processed at a time ... without explicit mutex logic"). Two workspaces for the
same user issued overlapping refreshes:

1. Request A reads stored `refresh_token = T`, passes the match check.
2. Request A `await`s the OpenAI `fetch()` → DO starts Request B.
3. Request B reads the SAME stored `T` (A hasn't written the rotation yet),
   passes the match check, and also `fetch()`es `T`.
4. OpenAI rotates `T` to `T'` on first use and **revokes the whole token
   family** when the now-consumed `T` is replayed by the second call.
5. Every subsequent refresh fails with 401 → codex re-refreshes in a loop →
   exceeds the rate limit → **429 in production**.

An `AbortController` timeout is NOT a mutex. It bounds how long one operation
runs; it does nothing to prevent two operations from running concurrently.

## Class of Bug

**Durable Object check-then-act race across an `await` boundary on a
one-time-use / rotating resource.** Any DO critical section that reads state,
makes an external mutation that invalidates that state, then persists the result
is vulnerable. One-time-use rotating credentials, monotonic sequence
allocators, "claim this slot" handlers, and idempotency-key consumers are all in
this class.

## Hard Requirements

1. **Do not rely on DO "single-threaded execution" to serialize across
   `await`.** It only serializes synchronous runs between `await` points. If
   your critical section `await`s anything (fetch, storage, crypto), concurrent
   invocations interleave.

2. **Serialize the critical section with a real mutex.** Use
   `ctx.blockConcurrencyWhile()` (when the whole DO should pause) or an in-memory
   promise-chain mutex (when only a specific critical section must serialize):

   ```ts
   private lock: Promise<unknown> = Promise.resolve();
   private withLock<T>(fn: () => Promise<T>): Promise<T> {
     const run = this.lock.then(() => fn());
     // keep the chain alive even if this run rejects, so a failure does not
     // permanently wedge the lock
     this.lock = run.then(() => undefined, () => undefined);
     return run;
   }
   ```

3. **Read the mutated state INSIDE the lock.** A check-then-act race is only
   fixed if the *read* is also serialized. Reading before acquiring the lock
   lets a queued request act on stale state. The fix is not just "lock the
   write" — it is "lock read→act→write as one unit" so a queued second request
   re-reads the post-mutation state and takes the already-rotated/idempotent
   path.

4. **The mutex must not permanently wedge on failure.** Chain the lock's
   continuation through both resolve and reject so a thrown critical section
   does not block all future requests.

## Required Tests

Any change to a DO check-then-act critical section on a rotating/one-time-use
resource MUST include a concurrency regression test that:

- Fires at least TWO overlapping invocations (`Promise.all`) with the same
  input, using **dynamic** mocks that model the state mutation (e.g. the
  external call rotates the stored value; the write advances it).
- Asserts the external one-time-use mutation happens **exactly once**
  (`expect(fetch).toHaveBeenCalledTimes(1)`), not once-per-request.
- Asserts the queued second invocation took the idempotent/grace path and the
  caller still received a usable result (not an error / not forced re-auth).
- Is proven discriminating: it MUST fail when the mutex is bypassed. Verify this
  once (temporarily bypass the lock, confirm the test goes red) before relying
  on it.

Static mocks that return a constant cannot model rotation and will pass even
without the mutex — they prove nothing.

## Quick Compliance Check

Before merging any DO change with a read→external-call→write critical section:
- [ ] The critical section is wrapped in a real mutex (`blockConcurrencyWhile`
      or a promise-chain lock), not relying on DO "single-threaded" assumptions
- [ ] The state read happens inside the lock, not before it
- [ ] The lock cannot wedge permanently on a thrown critical section
- [ ] A concurrency regression test asserts the one-time-use mutation fires
      exactly once under overlapping requests, with dynamic state-mutating mocks
- [ ] That test was verified to fail when the mutex is bypassed

## References

- Post-mortem: `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md`
- `.claude/rules/28` — credential resolution / rotation safety tests
- `.claude/rules/35` — vertical slice testing
- `.claude/rules/44` — dual-write migration must enumerate every writer
- Cloudflare docs: Durable Objects input/output gates and concurrency model
