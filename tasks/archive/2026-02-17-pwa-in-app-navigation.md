# PWA In-App Navigation

**Created**: 2026-02-17
**Status**: backlog

## Problem

When the app is installed as a PWA (standalone mode), tapping a workspace card on the dashboard calls `window.open(path, '_blank')`, which opens the system browser instead of navigating within the PWA. This breaks the standalone experience — the user sees a browser chrome bar at the top and loses the native-app feel.

In a normal browser tab this behavior is correct (open workspace in a new tab for multitasking). The fix should only change behavior when running as an installed PWA.

## Current Behavior

`WorkspaceCard.tsx` unconditionally uses `window.open(path, '_blank')`:

```typescript
const handleOpen = () => {
  const path = `/workspaces/${workspace.id}`;
  const opened = window.open(path, '_blank');
  if (opened) {
    try { opened.opener = null; } catch {}
    return;
  }
  navigate(path);
};
```

Other `target="_blank"` links (GitHub repo links, Hetzner console, credential help) are **external** URLs and should continue opening in the browser regardless of PWA mode.

## Desired Behavior

| Context | Internal links (same origin) | External links (different origin) |
|---------|------------------------------|-----------------------------------|
| **Normal browser** | Open in new tab (`_blank`) | Open in new tab (`_blank`) |
| **Installed PWA** | Navigate in-place (stay in PWA) | Open in system browser (current behavior is fine) |

## Research: PWA Detection

### Reliable detection methods

1. **CSS media query via JS** (recommended, cross-browser):
   ```typescript
   const isPWA = window.matchMedia('(display-mode: standalone)').matches;
   ```

2. **iOS Safari legacy** (needed for older iOS):
   ```typescript
   const isPWA = (navigator as any).standalone === true;
   ```

3. **Combined utility**:
   ```typescript
   export function isStandaloneMode(): boolean {
     return (
       window.matchMedia('(display-mode: standalone)').matches ||
       (navigator as any).standalone === true
     );
   }
   ```

### React hook approach

A `useIsStandalone()` hook using `matchMedia` listener would allow components to reactively adapt. This mirrors the existing `useIsMobile()` pattern in `apps/web/src/hooks/useIsMobile.ts`.

## Implementation Plan

### 1. Create `useIsStandalone` hook

- File: `apps/web/src/hooks/useIsStandalone.ts`
- Pattern: match `useIsMobile.ts` — `matchMedia('(display-mode: standalone)')` with change listener
- Include `navigator.standalone` fallback for iOS Safari

### 2. Update `WorkspaceCard.tsx` — workspace open behavior

- Import `useIsStandalone`
- If standalone: use `navigate(path)` (React Router in-place navigation)
- If browser: keep current `window.open(path, '_blank')` behavior
- The pop-up blocker fallback (`navigate(path)`) already does the right thing, so the change is straightforward

### 3. Audit other internal `_blank` links

Scan for any other same-origin `target="_blank"` or `window.open` calls that navigate within the app. External links (GitHub, Hetzner, Anthropic) should remain unchanged — they correctly open in the system browser from a PWA.

### 4. Tests

- Unit test for `useIsStandalone` hook (mock `matchMedia` and `navigator.standalone`)
- Unit test for `WorkspaceCard` verifying:
  - Standalone mode: calls `navigate()`, not `window.open()`
  - Browser mode: calls `window.open()` as before

## Files to Modify

- `apps/web/src/hooks/useIsStandalone.ts` (new)
- `apps/web/src/components/WorkspaceCard.tsx`
- Possibly other components if internal `_blank` links are found during audit

## Notes

- The manifest already sets `"display": "standalone"` so the detection query will match when installed
- No changes needed to the manifest, service worker, or PWA registration
- This is a small, focused change — no architectural impact
