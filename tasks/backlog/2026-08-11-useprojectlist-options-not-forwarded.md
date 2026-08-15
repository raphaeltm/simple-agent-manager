# `useProjectList` `status`/`sort` Options Are Accepted But Never Sent to the API

## Problem

`useProjectList()` (`apps/web/src/hooks/useProjectData.ts:6-19`) declares
`status` and `sort` as part of its `UseProjectListOptions` interface and
destructures them in the hook body, but its fetch function never forwards
either value to the API client — they are silently discarded. This was
discovered incidentally while auditing UI-to-backend data paths for
`tasks/archive/2026-08-10-ai-slop-debt-burndown.md`; it is not caused by and
not fixed by that task.

## Context

```ts
interface UseProjectListOptions {
  status?: string;
  sort?: string;
  limit?: number;
  pollInterval?: number;
}

export function useProjectList(options: UseProjectListOptions = {}): UseProjectListResult {
  const { status, sort, limit, pollInterval = 30000 } = options;
  // ...
  const fetchProjects = useCallback(async () => {
    // ...
    const result = await api.listProjects(limit); // status, sort never passed
    // ...
  }, [status, sort, limit]); // included in deps, implying they were meant to affect the fetch
```

The dependency array even lists `status` and `sort`, which strongly suggests
the original intent was for them to affect the request — but the call site
(`api.listProjects(limit)`) only ever forwards `limit`.

The gap is two layers deep, both need fixing together:

1. `api.listProjects()` (`apps/web/src/lib/api/projects.ts:116-125`) only
   accepts `(limit?, cursor?)` — there is no parameter to pass `status` or
   `sort` through even if the hook wanted to.
2. The server-side route DOES support both:
   `apps/api/src/routes/projects/crud.ts:445-454` reads
   `c.req.query('status')` and `c.req.query('sort')` (defaulting to
   `'last_activity'`) and applies them to the query — so the backend
   capability already exists and is unused by this client path.

### Why this hasn't been visibly broken yet

Both current call sites (`apps/web/src/pages/Dashboard.tsx:15` and
`apps/web/src/pages/Projects.tsx:11`) call
`useProjectList({ sort: 'last_activity', limit: 50 })`. Since the server's
own default sort is also `'last_activity'`
(`crud.ts:454`: `c.req.query('sort')?.trim() || 'last_activity'`), the
requested value happens to coincidentally match the default, masking the bug.
No current call site passes `status` at all
(`apps/web/src/components/AppShell.tsx:67` passes neither). A future caller
requesting a non-default sort or any status filter would silently get
unsorted/unfiltered results with no error.

## Acceptance Criteria

- [ ] `api.listProjects()` accepts `status`/`sort` parameters (or an options
      object) and forwards them as query parameters, mirroring the existing
      `limit`/`cursor` pattern.
- [ ] `useProjectList`'s `fetchProjects` passes `status` and `sort` through to
      `api.listProjects()`.
- [ ] A test proves a non-default `sort`/`status` value passed to
      `useProjectList` reaches the outgoing API request (see
      `.claude/rules/06-technical-patterns.md` "UI-to-Backend Data Path
      Verification").
- [ ] Confirm whether any product surface actually needs `status`/`sort`
      filtering on the projects list today; if not, consider removing the
      dead options instead of wiring them, per "No dead code" (root
      `CLAUDE.md`).

## References

- `apps/web/src/hooks/useProjectData.ts:6-44`
- `apps/web/src/lib/api/projects.ts:116-125`
- `apps/api/src/routes/projects/crud.ts:445-454`
- `tasks/archive/2026-08-10-ai-slop-debt-burndown.md` (discovered during this task's boundary validation audit)
- `.claude/rules/06-technical-patterns.md` (UI-to-Backend Data Path Verification)
