/**
 * PROTOTYPE ONLY — styles for the chat-surface prototype, injected as one <style> tag while
 * the prototype is on so no global stylesheet changes. Everything keys off the data
 * attributes `prototype-state.ts` sets on <html>. Remove before merge to main.
 */
const CSS = `
/* ── Open agent messages: no bubble, full column width ─────────────────────── */
html[data-proto-agent='open'] .proto-msg-open {
  max-width: 100%;
  width: 100%;
  padding: 0 2px;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  color: var(--sam-color-fg-primary);
}
@media (min-width: 768px) {
  html[data-proto-agent='open'] .proto-msg-open { max-width: 46rem; }
}
@media (max-width: 767px) {
  html[data-proto-agent='open'] .sam-message-entry { padding-left: 12px; padding-right: 12px; }
}

/* ── Immersive toggle sits bottom-right; the scroll button moves beside it ── */
@media (max-width: 767px) {
  html[data-proto-immersive] .sam-scroll-button { right: 4.25rem; }
}
.proto-immersive-toggle {
  bottom: 0.75rem;
  transition: transform 200ms ease, background-color 150ms ease;
}
.proto-immersive-toggle[data-agent-active='true'] { transform: translate3d(0, -2.75rem, 0); }

/* ── Immersive: one layout change; the slide itself is transform-only ────────
   immersive-transition.ts pins each piece of chrome with position: fixed, so it leaves the
   flow at once and the conversation expands underneath it. These rules only finish that
   single layout change, and hide any piece React remounted while pinned. */
@media (max-width: 767px) {
  html[data-proto-immersive='on'] .sam-void { padding: 6px; }
  html[data-proto-immersive='on'] div:has(> [data-testid='session-tool-rail']) {
    width: 0 !important;
  }
  html[data-proto-immersive='on'] .sam-void > header:not([data-proto-pinned]),
  html[data-proto-immersive='on'] [data-testid='session-floating-header']:not([data-proto-pinned]),
  html[data-proto-immersive='on'] [data-testid='session-tool-rail']:not([data-proto-pinned]),
  html[data-proto-immersive='on'][data-proto-composer='hide']
    [data-testid='session-footer']:not([data-proto-pinned]) {
    display: none;
  }
  /* The rail had no fill of its own inside the pane; pinned over the conversation it needs one. */
  [data-testid='session-tool-rail'][data-proto-pinned] {
    background: var(--sam-glass-v2-raised);
    border-radius: var(--sam-radius-pane) 0 0 var(--sam-radius-pane);
  }
}

`;

export function injectChatSurfacePrototypeStyles() {
  const style = document.createElement('style');
  style.dataset.prototype = 'chat-surface';
  style.textContent = CSS;
  document.head.appendChild(style);
}
