# Fix hardcoded vmLocation default in run.ts

## Problem

`apps/api/src/routes/tasks/run.ts:153` uses a hardcoded `'nbg1'` string for the default VM location:

```typescript
const vmLocation: VMLocation = (body.vmLocation as VMLocation) ?? 'nbg1';
```

The sister file `submit.ts` correctly imports and uses `DEFAULT_VM_LOCATION` from `@simple-agent-manager/shared`. This creates a divergence: changing the platform default in `constants.ts` would affect `submit.ts` but silently leave `run.ts` pointing at Nuremberg.

**Discovered by**: Constitution validator (Principle XI — No Hardcoded Values) during PR #370 review.

## Resolution

Already fixed in the current codebase. `run.ts` imports `DEFAULT_VM_LOCATION` from `@simple-agent-manager/shared` (line 17) and uses it on line 160. Both `run.ts` and `submit.ts` now use the same default pattern for vmSize, vmLocation, and workspaceProfile.

## Acceptance Criteria

- [x] Import `DEFAULT_VM_LOCATION` in `apps/api/src/routes/tasks/run.ts`
- [x] Replace `?? 'nbg1'` with `?? DEFAULT_VM_LOCATION` on the vmLocation line
- [x] Verify `submit.ts` and `run.ts` use the same default pattern for all three config values (vmSize, vmLocation, workspaceProfile)
