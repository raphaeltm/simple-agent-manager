# Stale-While-Revalidate UI (No Hiding, No Refetch Loops)

## Why This Rule Exists

On 2026-07-10 the project settings page became unusable: after creating an
invite link, the entire settings UI unmounted and slowly rebuilt every ~1
second, forever. The loop was a chain of three anti-patterns that each looked
harmless in isolation:

1. `ToastProvider` passed an inline object as its context value
   (`value={{ addToast, success, error, ... }}`), so **every toast state
   change gave every toast consumer a new context identity** — even though all
   five functions were individually `useCallback`-stable.
2. Data loaders were declared as `useCallback(load, [projectId, toast])` and
   triggered by `useEffect(() => { void load(); }, [load])`. The new toast
   identity recreated the loader, which re-fired the effect, which refetched.
3. Loaders called `setLoading(true)` on every run and components rendered
   `{loading ? <Spinner/> : <content>}`, so each refetch **unmounted the
   content**. When a loader's `catch` called `toast.error(...)`, the failure
   toast itself re-triggered the loader — a self-sustaining loop with period ≈
   fetch latency.

`AuthProvider` (unmemoized context value, re-emitting on every BetterAuth
session refetch/focus) and `Project.tsx` (swapping the entire `<Outlet/>` for
a spinner on every `reload()`) amplified the blast radius to the whole app.

## Hard Rules

### 1. Context provider values MUST be memoized

Every `<X.Provider value={...}>` must receive a `useMemo`-stable value (or a
value from state/ref). Never an inline object/array literal, and never an
unmemoized `const value = {...}` built during render.

Enforced by ESLint: `react/jsx-no-constructed-context-values` is `error` for
all `.tsx` files (see `.eslintrc.cjs`). Do not disable it inline; fix the
provider instead.

```tsx
// GOOD
const value = useMemo(() => ({ user, isLoading, reload }), [user, isLoading, reload]);
return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
```

The functions inside the value must themselves be `useCallback`-stable, or the
`useMemo` is pointless.

### 2. Never put a context-object dependency in a data-loader's deps

`useCallback(load, [projectId, toast])` + `useEffect(..., [load])` means "refetch
whenever the toast context changes identity." Even with memoized providers this
couples fetching to unrelated state. Instead:

- Depend only on the identifiers that define WHAT to fetch (`projectId`, ids,
  filters).
- Context values like `toast` are stable after Rule 1 — but still prefer
  referencing them without listing the whole context object when only stable
  member functions are used.
- NEVER call `toast.error(...)` (or any state-setting function that can feed
  back into the loader's deps) from a loader's `catch` unless you have verified
  the dependency chain cannot re-trigger the loader.

### 3. Loading spinners only when there is NO data (stale-while-revalidate)

A refetch must never unmount already-rendered content:

```tsx
// BAD — content unmounts on every refetch
{loading ? <Spinner /> : <Content data={data} />}

// GOOD — spinner only before first data; refetches keep content visible
{data === null ? <Spinner /> : <Content data={data} />}
```

- Track "have we ever loaded" (`data !== null`, or a `hasLoadedRef`) separately
  from "a fetch is in flight" (`isFetching`).
- `setLoading(true)` at the top of every loader run is wrong unless it is
  guarded to the first load.
- Parent layouts (e.g. `Project.tsx`) must never swap a mounted `<Outlet/>` /
  child tree for a spinner during a background `reload()` — that destroys all
  child state. Only the very first load for a given entity may gate rendering.

This extends `.claude/rules/16-no-page-reload-on-mutation.md`: not only is
`window.location.reload()` banned after mutations, so is any refetch pattern
that visually resets the page.

### 4. Prefer TanStack Query for new/modified fetch surfaces

The app has a configured TanStack Query v5 client (`apps/web/src/lib/query-client.ts`,
wired in the app root). For any NEW data-fetching surface, and when materially
modifying an existing one, use `useQuery`/`useMutation` instead of hand-rolled
`useState + useCallback + useEffect` loader triplets:

- `isLoading` (no data yet) vs `isFetching` (background refresh) gives
  stale-while-revalidate for free — gate render on `isLoading` only.
- Use `queryClient.invalidateQueries(...)` after mutations instead of
  `await reload()` chains threaded through context.
- Use `refetchInterval` instead of hand-rolled `setInterval` polls.

Hand-rolled loaders are only acceptable for genuinely non-query state
(WebSockets, streaming, imperative one-shots).

## Interaction-Effect Trace Requirement

When adding any state change that a `useEffect` in the same tree observes
(including via context identity), trace the loop per
`.claude/rules/06-technical-patterns.md` → "React Interaction-Effect Analysis":
what re-renders, what identities change, which effects re-fire, and can the
effect's own side effects re-trigger it? A cycle anywhere in that graph is a
merge blocker.

## Quick Compliance Check

Before committing UI data-fetching or context changes:
- [ ] Every `Provider value=` is `useMemo`-stable (lint enforces this)
- [ ] No loader `useCallback` lists a context object (e.g. `toast`) in deps
- [ ] No loader `catch` sets state that can re-trigger the loader
- [ ] Spinners gate only on "no data yet", never on "refetch in flight"
- [ ] Mutations invalidate/refresh data without unmounting visible content
- [ ] New fetch surfaces use TanStack Query (or document why not)
