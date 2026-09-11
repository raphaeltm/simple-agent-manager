# Bookmark-anchored D1 reads: remove the last primary round trip

**Status**: backlog — needs a product decision before implementation
**Created**: 2026-09-11
**Parent**: `tasks/active/2026-09-11-cut-api-latency-d1-replication-and-auth-dedup.md`
**Idea**: `01M27KAF3Z9YEM6VADJKE1ZXC6`

## Why this exists

The parent task asked for D1 **bookmark** propagation (read the client's bookmark from a cookie
or header, pass it to `withSession(bookmark)`, write `session.getBookmark()` back on the
response). It was deliberately NOT shipped. This file is the tracked deferral, so the decision
is not lost.

## What shipped instead

`withSession('first-primary')` (`apps/api/src/lib/d1-session.ts`). The first query of a request
goes to the primary and everything after it may be served by a replica caught up to that
bookmark. That removes N-1 of N trans-Atlantic round trips per request **with no staleness
change whatsoever** — a request can never miss a write that completed before it began.

## What bookmark anchoring would add, and what it costs

**Adds:** it removes the last primary round trip, which is the entire remaining floor for small
routes. `/api/auth/me` is ~2 queries, so `first-primary` leaves it at roughly one 138 ms hop
plus the network floor; bookmark anchoring would take it to near the floor alone.

**Costs:** a read could be served by a replica that has not yet seen **another actor's** write.
The bookmark only constrains reads to what *this client* has already seen. In SAM the writer a
user is waiting on is almost always an **agent** (via MCP or a VM-agent callback), not that
user's own browser — so a user could poll and not see an agent's just-written task or status
for the replication-lag window. That is a user-visible bounded staleness window: a product
decision, not an optimisation, which is why the parent task's instruction was to stop and ask.

Two implementation hazards that also need answering:

1. **Concurrent in-flight requests.** A browser has several requests in flight; whichever
   response lands last wins the cookie, so a slow read can overwrite a newer write's bookmark
   with an older one. The obvious fix — keep the larger bookmark — has no guarantee behind it:
   Cloudflare does **not** document D1 bookmarks as ordered or comparable (verified against the
   read-replication docs on 2026-09-11). A safe variant is to set the cookie only on responses
   to mutating requests, which narrows but does not close the hole for two concurrent writes.
2. **A stale cookie is a weak constraint, not a strong one.** An old bookmark imposes almost no
   freshness requirement, so bookmark-anchored reads behave close to `first-unconstrained` in
   practice.

## The decision needed

Is a bounded (replication-lag) window in which a browser read can miss an **agent's** write
acceptable on read-only endpoints, in exchange for roughly 140 ms off every request?

Bring the parent PR's measured after-numbers to that conversation — if `first-primary` already
put the hot routes in a good place, the remaining hop may simply not be worth the consistency
question.

## If the answer is yes

- [ ] Decide the transport (cookie vs. header) and why it survives concurrent in-flight requests.
- [ ] Anchor **only** browser GET/HEAD requests. MCP, CLI and VM-agent callback routes have no
      cookie and must stay `first-primary`; a cleanup/sweep/terminal-verdict path must never
      read a replica (`.claude/rules/58`, `.claude/rules/66`).
- [ ] Keep `first-primary` as the fallback whenever no valid bookmark is presented.
- [ ] Prove read-after-write across requests against real replicas on staging, not Miniflare —
      Miniflare has no replicas and cannot observe this class at all (`.claude/rules/69`).
- [ ] Document the accepted staleness window in `apps/www/src/content/docs/docs/architecture/overview.md`.

## References

- Parent task's "A2" design section and its "Follow-up" note.
- `apps/api/src/lib/d1-session.ts` — the `## Why first-primary and not a bookmark` header block.
- Cloudflare D1 read replication / Sessions API docs.
