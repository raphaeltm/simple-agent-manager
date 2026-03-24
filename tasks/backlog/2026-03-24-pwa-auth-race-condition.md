# Fix PWA Auth Status Race Condition

## Problem

When a user returns to the PWA after switching apps on mobile, they briefly see the login page even though they're still authenticated. On refresh they're logged back in but stuck on `/dashboard` instead of their original page.

## Root Cause

Three interacting issues in the auth flow:

### 1. BetterAuth wipes session on refetch error

When the tab regains focus, BetterAuth's session refresh manager triggers a `/get-session` refetch via `visibilitychange`. If the fetch fails (common on mobile — network not immediately available after background), `query.mjs` `onError` and `.catch()` both set `data: null, isPending: false`, wiping the previously valid session.

Key code path: `focus-manager.mjs` → `session-refresh.mjs:triggerRefetch()` → `query.mjs:fn()` → on network error → `data: null`

During the fetch, `onRequest` correctly preserves existing data (`data: currentValue.data`), but `onError` and `.catch()` discard it.

### 2. ProtectedRoute immediately redirects on `!isAuthenticated`

`ProtectedRoute.tsx:25-26` redirects to `/` as soon as `isLoading=false` and `isAuthenticated=false`, with no grace period for transient errors. The `isRefetching` flag from BetterAuth could distinguish "checking session" from "definitely not authenticated."

### 3. Landing page ignores `location.state.from`

`Landing.tsx:14-18` always navigates to `/dashboard` when `isAuthenticated` becomes true, ignoring the `state.from` that `ProtectedRoute` passed.

## Research Findings

- **BetterAuth useSession return shape**: `{ data, error, isPending, isRefetching, refetch }` (from nanostore atom in `query.mjs`)
- **`onRequest` preserves data**: Sets `data: currentValue.data` and `isRefetching: true` during fetch
- **`onError`/`.catch()` clear data**: Both set `data: null`, which causes `isAuthenticated` to become `false`
- **`isRefetching` is available**: Set to `true` during refetch, `false` after — can be used to distinguish transient state
- **AuthProvider.tsx** (line 38): Only destructures `{ data: session, isPending }` from `useSession()` — doesn't use `error` or `isRefetching`
- **ProtectedRoute.tsx** (line 25): Immediate redirect on `!isAuthenticated` — no transient error handling
- **Landing.tsx** (line 16): Hardcodes `navigate('/dashboard')` — ignores `location.state?.from`
- **Test mocking pattern**: Tests mock `useAuth` via `vi.mock('../../src/components/AuthProvider', ...)` returning `{ useAuth: () => ({...}) }`

## Implementation Checklist

### Fix 1: AuthProvider — Last-known-good session caching
- [ ] Add `useRef` to cache the last valid session data
- [ ] Destructure `error` and `isRefetching` from `useSession()` in addition to existing fields
- [ ] When `error` is truthy and `lastGoodSession.current` exists, use the cached session instead of null
- [ ] Add `isRefetching` to the context value so downstream components can distinguish transient states
- [ ] Update `AuthContextValue` interface to include `isRefetching`

### Fix 2: ProtectedRoute — Transient error resilience
- [ ] Destructure `isRefetching` from `useAuth()`
- [ ] Treat `isRefetching` as a loading-like state: don't redirect while a refetch is in progress
- [ ] Show spinner during refetch (same as `isLoading`)

### Fix 3: Landing — Respect `state.from`
- [ ] Read `location.state?.from` using `useLocation()`
- [ ] Navigate to `state.from.pathname + state.from.search + state.from.hash` if available
- [ ] Fall back to `/dashboard` if no `from` state

### Tests
- [ ] Unit test: AuthProvider preserves session when refetch has error but last-good session exists
- [ ] Unit test: AuthProvider clears session when error occurs with no prior session
- [ ] Unit test: ProtectedRoute shows spinner during refetch (isRefetching=true)
- [ ] Unit test: ProtectedRoute redirects when not refetching and not authenticated
- [ ] Unit test: Landing navigates to `state.from` when available
- [ ] Unit test: Landing navigates to `/dashboard` when no `state.from`
- [ ] Behavioral test: simulate visibilitychange with network error, verify user stays on page

## Acceptance Criteria

- [ ] User returning to PWA after app switch does not see login page if session is still valid
- [ ] If refetch succeeds after transient error, user remains on their original page
- [ ] If refetch fails and session is truly expired, user is redirected to login normally
- [ ] After redirect to login, successful re-auth returns user to their original page (not hardcoded /dashboard)
- [ ] All existing auth tests continue to pass

## Files to Modify

- `apps/web/src/components/AuthProvider.tsx`
- `apps/web/src/components/ProtectedRoute.tsx`
- `apps/web/src/pages/Landing.tsx`
- `apps/web/tests/unit/pages/landing.test.tsx` (replace source-contract test with behavioral tests)
- New: `apps/web/tests/unit/components/auth-provider.test.tsx`
- New: `apps/web/tests/unit/components/protected-route.test.tsx`

## References

- BetterAuth query.mjs: `node_modules/.pnpm/better-auth@*/node_modules/better-auth/dist/client/query.mjs`
- BetterAuth session-refresh.mjs: Same path `/dist/client/session-refresh.mjs`
- `.claude/rules/06-technical-patterns.md` — React Interaction-Effect Analysis
