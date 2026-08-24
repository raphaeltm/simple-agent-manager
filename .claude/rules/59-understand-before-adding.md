# Understand the System Before Adding to It

## When This Applies

Every code change — but especially: adding code to middleware, auth, context
providers, or any shared path; creating a new helper, hook, service, or utility;
adding a D1 query, DO RPC, or fetch call.

## Why This Rule Exists

Three agents independently added OAuth provider helpers, each calling
`resolvePlatformConfig()` because that was the obvious local pattern. Each PR was
correct. The aggregate was 39 redundant D1 queries on every authenticated request.
No agent traced the full request lifecycle to see what was already running.

54 data-fetching hooks were hand-rolled `useState + useEffect` because each agent
solved its local problem without searching for the established TanStack Query
pattern. `ensureProjectId` was called before every DO method because the first
agent didn't realize the DO was already keyed by project ID, and every subsequent
agent copied the pattern without questioning it.

The class of bug: **an agent treats its task as an isolated problem, writes
locally-correct code, and never considers the system it's contributing to.**

## Hard Requirements

### Before Adding Code to a Shared Path

When modifying code that runs on many requests or renders (middleware, auth,
route-level `use()`, React context providers, shared layouts, base components):

1. **Trace the full lifecycle first.** Read what already runs on this path. For
   middleware: trace from request entry through every `use()` to the handler. For
   context providers: identify consumers. Write this trace in your task notes.

2. **State the multiplication factor.** "This middleware runs on every
   authenticated request." "This context provider wraps 90 pages." If you can't
   state the factor, you don't understand the system well enough to modify it.

3. **Measure aggregate cost, not local cost.** Not "my code adds 1 D1 query" but
   "my code adds 1 D1 query × every authenticated request."

### Before Creating a New Helper, Hook, or Pattern

1. **Search for existing implementations.** Grep for the same data being fetched,
   the same operation being performed, the same pattern being used. If a function
   already does what you need, call it. If an established pattern exists (e.g.
   TanStack Query for data fetching in `apps/web/`), follow it.

2. **Extend, don't fork.** If the existing implementation doesn't quite fit,
   extend it. Do not create a parallel version. If you must diverge, justify it
   technically in the PR — "it was faster to write" is not a justification.

3. **Question copied patterns.** "The GitHub OAuth helper calls
   `resolvePlatformConfig`, so my GitLab helper should too" is cargo-culting. Ask:
   is the existing pattern correct, or am I propagating a mistake?

### Before Adding a Dependency or Import

1. **Check if the codebase already has a library for the same purpose.** Do not
   add a second date library, charting library, or markdown parser.

2. **Understand where your import ends up.** A top-level import in a file
   statically imported by `App.tsx` ships to every user on every page load.

## Anti-Patterns (Banned)

| Anti-Pattern | What to Do Instead |
|---|---|
| "I copied the pattern from the adjacent file" | Question whether the source pattern is correct first |
| "My change only adds one query" | State the multiplier — one query × every request = thousands |
| "I wrote a custom hook because it was simpler" | Use the established pattern (TanStack Query, shared service) |
| "The existing helper doesn't do exactly what I need" | Extend it, don't fork it |
| "I didn't have time to understand the full path" | You don't have enough context to modify it safely; read first |

## Quick Compliance Check

Before committing code on a shared path:
- [ ] Traced the full request/render lifecycle this code participates in
- [ ] Stated the multiplication factor
- [ ] Measured aggregate cost, not just local cost

Before creating a new helper/hook/utility:
- [ ] Searched for existing implementations of the same operation
- [ ] Used or extended an existing pattern if one exists
- [ ] If diverged: justified in PR why the existing pattern couldn't work
- [ ] If copied a pattern: verified the source pattern is correct
