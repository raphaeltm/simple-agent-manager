# Post-Mortem: Scaleway Node Creation Fails Silently

**Date**: 2026-03-14
**Severity**: High — core feature completely broken for Scaleway users
**Time to detect**: ~1 day (user tried it manually on staging)
**Time to fix**: ~2 hours

## What Broke

Creating a node with Scaleway selected in the UI failed silently. The node showed "Error" status with the message "Node provisioning failed" — no provider name, no API error, no observability trail. The admin error dashboard had nothing.

## Root Cause

Two independent bugs combined to make Scaleway node creation impossible:

### Bug 1: Provider selection never sent to backend

The catalog PR (`d21ad6e`, PR #373) added a provider dropdown to the Nodes page UI:

```tsx
// State was added
const [selectedProvider, setSelectedProvider] = useState('');

// Dropdown was rendered
<Select id="node-provider" value={selectedProvider} onChange={...}>
  <option value="hetzner">Hetzner</option>
  <option value="scaleway">Scaleway</option>
</Select>
```

But `handleCreateNode()` never included it in the API call:

```tsx
// Nodes.tsx:handleCreateNode() — missing provider
const created = await createNode({
  name: `node-${timestamp}`,
  vmSize: newNodeSize,
  vmLocation: newNodeLocation,
  // selectedProvider is NOT sent
});
```

And `CreateNodeRequest` in the shared types didn't even have a `provider` field, so even if the UI tried to send it, TypeScript would have caught the mismatch — which means nobody tried.

### Bug 2: Credential lookup ignored provider type

The API generalization PR (`6de0204`, PR #363) created `getUserCloudProviderConfig()` to replace hardcoded Hetzner lookups. But the replacement was:

```typescript
// provider-credentials.ts — picks whichever credential is first in DB
const creds = await db
  .select()
  .from(schema.credentials)
  .where(and(
    eq(schema.credentials.userId, userId),
    eq(schema.credentials.credentialType, 'cloud-provider'),
  ))
  .limit(1);  // ← first one wins, regardless of provider
```

With both Hetzner and Scaleway credentials in the DB, Hetzner was returned first. A Scaleway location like `fr-par-1` was sent to Hetzner's API, which rejected it.

## Timeline

| When | What |
|------|------|
| Mar 13, 12:23 | PR #363 merges: API generalization creates `getUserCloudProviderConfig()` with `.limit(1)` and no provider filter. **Bug 2 introduced.** |
| Mar 13, 23:05 | PR #373 merges: Catalog PR adds provider dropdown to UI but doesn't wire it to the API call. **Bug 1 introduced.** |
| Mar 13, ~23:30 | User adds Scaleway credentials on staging |
| Mar 14, 08:01 | User tries to create a Scaleway node. Fails with "Node provisioning failed". |
| Mar 14, 08:01 | User checks admin logs. Nothing there. |
| Mar 14, 08:36 | Fix deployed to staging. Scaleway node created, heartbeat received, lifecycle verified. |

## Why It Wasn't Caught

### 1. The bug was identified during research and then not fixed

The catalog task file (`2026-03-13-provider-agnostic-instance-catalog.md`) literally documents the problem:

> **Line 16–17**: `getUserCloudProviderConfig()`: Returns first credential found — **no provider selection**
>
> **Key files to modify, item 7**: `apps/api/src/services/provider-credentials.ts` — Support provider selection when user has multiple

This was listed as research finding and as a file to modify. It was never modified. The task was marked complete and archived anyway.

### 2. The UI dropdown was cosmetic — no data path to the backend

The catalog PR added a `<Select>` for provider, managed `selectedProvider` state, and used it to filter which catalog data to display (locations, sizes). But `handleCreateNode()` was copy-pasted from the pre-catalog version without adding the provider field. The dropdown looked functional in the UI — you could select Scaleway, see Scaleway locations and prices — but the selection was silently discarded when you clicked "Create Node."

### 3. No test exercised the multi-provider path

Every test created nodes with a single provider. No test set up two credentials and verified the correct one was selected. The test for `getUserCloudProviderConfig` only tested the single-credential case.

### 4. No integration or E2E test for node creation

The entire node creation flow — from UI click through API to provider API call — had no integration test. Individual pieces were tested (credential lookup, provider factory, API route handlers) but nobody tested whether a Scaleway selection in the UI resulted in a Scaleway API call on the backend.

### 5. Error messages hid the failure

When Hetzner's API rejected the Scaleway location `fr-par-1`, the error was caught and stored as "Node provisioning failed" with no provider name, no API response, and no observability persistence. The admin errors dashboard showed nothing because `provisionNode()` only used `console.error()`, which goes to Cloudflare's transient logs (7-day retention, not queryable from the UI).

## Class of Bug

**Disconnected UI state** — a UI element collects user input that is never propagated to the backend. The UI provides the *appearance* of a choice without the *reality* of one. This is particularly insidious because:

1. The user sees a dropdown with the right options
2. The user makes a selection and sees the UI respond (locations change, sizes update)
3. The user clicks "Create" and reasonably believes their selection was submitted
4. The backend does something completely different

Combined with **non-deterministic resource selection** — a function that picks from a set without the caller specifying which item, making behavior dependent on database ordering.

## Process Failures

### Task completion without verification

Both tasks (#363 and #373) were marked complete based on:
- TypeScript compiles
- Tests pass
- UI renders correctly

Neither task verified the end-to-end flow: "select Scaleway in UI → node provisioned on Scaleway." The catalog task even had an acceptance criterion — "User with both providers can select which provider to use" — that was checked off without being tested.

### Research findings not converted to implementation items

The catalog task's research section identified `getUserCloudProviderConfig()` as needing provider selection support. This finding appeared in the research section but was never added to the implementation checklist. The implementation checklist focused on UI and API catalog endpoints, not on the credential lookup fix.

### Adjacent PRs not cross-checked

PR #363 (API generalization) and PR #373 (catalog UI) were developed sequentially on the same day. PR #373 should have verified that the provider selection it added in the UI was actually consumable by the API that PR #363 modified. Neither PR's review caught the gap.

## What Was Fixed (PR #377)

1. **Added `provider` field to `CreateNodeRequest`** — UI now sends `selectedProvider` in the API call
2. **Added `cloud_provider` column to `nodes` table** — node records track which provider was selected
3. **Updated `getUserCloudProviderConfig()` with `targetProvider` filter** — credential lookup respects the caller's provider choice
4. **Persisted provisioning errors to observability DB** — errors now show provider name, vmSize, vmLocation, HTTP status code
5. **Stored actual error messages on node records** — instead of generic "Node provisioning failed"

## Process Fixes

### Rule: UI-to-backend data path verification (new)

When a UI element collects a user choice that affects backend behavior, the PR must include a test (or explicit manual verification) that traces the value from the UI event handler through the API request to the backend function that acts on it. A dropdown that isn't wired to the API call is worse than no dropdown — it creates false confidence.

### Rule: Research findings must become checklist items or explicit deferrals

If pre-implementation research identifies a problem ("X doesn't support Y"), the finding must either:
- Become a checklist item in the implementation plan, or
- Be explicitly deferred with a backlog task reference

Findings that exist only in a "Research" section and not in the "Implementation Checklist" will be forgotten.

### Rule: Multi-resource acceptance criteria require multi-resource test data

If an acceptance criterion says "User with both X and Y can choose between them," the verification must set up both X and Y and exercise the choice. Testing with only X present doesn't verify selection logic — it verifies fallback logic.
