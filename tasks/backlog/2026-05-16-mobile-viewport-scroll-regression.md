# Mobile viewport and pull-to-refresh regression

## Problem

PR #1030 (`b7e7655b`) fixed document-level scroll on the chat page by changing `html, body, #root` from:
```css
min-height: var(--sam-app-height);
overflow-x: hidden;
```
to:
```css
height: var(--sam-app-height);
overflow: hidden;
```

This introduced two mobile regressions:

### 1. Pull-to-refresh broken
`overflow: hidden` on `html` prevents the browser's native overscroll gesture. Users can no longer pull-to-refresh on mobile Chrome/Safari.

### 2. Input clipped below fold on mobile Chrome
`--sam-app-height: 100dvh` represents the viewport with the URL bar collapsed. On initial page load in mobile Chrome, the URL bar is visible and the actual viewport is ~56px shorter. The bottom of the app (chat input) is hidden below the visible area. Normally, scrolling would collapse the URL bar to reveal the full viewport, but `overflow: hidden` prevents any scroll, so users are stuck.

The PWA works fine because it has no URL bar. But browser users (and anyone opening an exposed port URL) are affected.

## Context

- Discovered while viewing a prototype URL in mobile Chrome (port exposure URLs open in the browser, not the PWA)
- The original bug: chat content overflow caused the document to scroll, moving the sidebar off-screen
- Both bugs are caused by the same CSS change

## Root Cause

The scroll fix was too aggressive. `overflow: hidden` on `html` and `body` kills all document-level scroll behavior, including browser-native gestures.

## Proposed Fix

```css
html, body {
  height: var(--sam-app-height);
  /* Do NOT set overflow: hidden here — it kills pull-to-refresh and
     prevents mobile Chrome's URL bar collapse behavior */
}

#root {
  height: var(--sam-app-height);
  overflow: hidden;  /* Contain the app layout here, not at document level */
}
```

Additionally, consider using `100svh` (small viewport height = with URL bar visible) instead of `100dvh` for the initial sizing, or use the `env(safe-area-inset-bottom)` approach:

```css
:root {
  --sam-app-height: 100svh;
}

@supports (height: 100dvh) {
  :root {
    /* Use dvh only when the browser supports it AND we're in standalone mode (PWA) */
    --sam-app-height: 100dvh;
  }
}

/* For PWA / standalone, dvh is correct because there's no URL bar */
@media (display-mode: standalone) {
  :root {
    --sam-app-height: 100dvh;
  }
}
```

The simpler fix is to just move `overflow: hidden` from `html, body` to only `#root`. This keeps the layout contained (fixing the original scroll bug) while allowing the browser to handle its own viewport/overscroll behavior.

## Acceptance Criteria

- [ ] Chat page does not have document-level scroll (original bug stays fixed)
- [ ] Pull-to-refresh works on mobile Chrome and Safari
- [ ] Chat input is visible on initial page load in mobile Chrome (URL bar visible state)
- [ ] PWA mode still works correctly (no extra scroll)
- [ ] Desktop behavior unchanged
- [ ] Playwright scroll containment tests still pass

## Priority

High — affects all mobile browser users (non-PWA)
