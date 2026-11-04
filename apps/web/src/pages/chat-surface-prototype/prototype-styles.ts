/**
 * PROTOTYPE ONLY — styles for the chat-surface prototype, injected as one <style> tag while
 * the prototype is on so no global stylesheet changes. Everything keys off the data
 * attributes `prototype-state.ts` sets on <html>. Remove before merge to main.
 *
 * Height collapses animate through `interpolate-size: allow-keywords` (Chrome 129+); other
 * browsers snap instead of sliding.
 */
const CSS = `
:root { interpolate-size: allow-keywords; }

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

/* ── Immersive: the chrome slides away so the conversation fills the screen ─ */
@media (max-width: 767px) {
  html[data-proto-immersive] .sam-void,
  html[data-proto-immersive] .sam-void > header,
  html[data-proto-immersive] [data-testid='session-floating-header'],
  html[data-proto-immersive] [data-testid='session-footer'],
  html[data-proto-immersive] div:has(> [data-testid='session-tool-rail']),
  html[data-proto-immersive] [data-testid='session-tool-rail'] {
    transition:
      height 340ms cubic-bezier(0.32, 0.72, 0, 1),
      width 340ms cubic-bezier(0.32, 0.72, 0, 1),
      padding 340ms cubic-bezier(0.32, 0.72, 0, 1),
      margin 340ms cubic-bezier(0.32, 0.72, 0, 1),
      transform 340ms cubic-bezier(0.32, 0.72, 0, 1),
      opacity 220ms ease;
  }

  html[data-proto-immersive='on'] .sam-void { padding: 6px; }

  html[data-proto-immersive='on'] .sam-void > header {
    height: 0;
    margin-bottom: -10px;
    opacity: 0;
    transform: translateY(-16px);
    overflow: clip;
    pointer-events: none;
  }

  html[data-proto-immersive='on'] [data-testid='session-floating-header'] {
    height: 0;
    min-height: 0;
    margin-bottom: -10px;
    opacity: 0;
    transform: translateY(-16px);
    overflow: clip;
    pointer-events: none;
  }

  html[data-proto-immersive='on'][data-proto-composer='hide'] [data-testid='session-footer'] {
    height: 0;
    margin-top: -10px;
    opacity: 0;
    transform: translateY(16px);
    overflow: clip;
    pointer-events: none;
  }

  html[data-proto-immersive='on'] div:has(> [data-testid='session-tool-rail']) {
    width: 0 !important;
  }
  html[data-proto-immersive='on'] [data-testid='session-tool-rail'] {
    transform: translateX(100%);
    opacity: 0;
    pointer-events: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  html[data-proto-immersive] * { transition-duration: 0.01ms !important; }
}
`;

export function injectChatSurfacePrototypeStyles() {
  const style = document.createElement('style');
  style.dataset.prototype = 'chat-surface';
  style.textContent = CSS;
  document.head.appendChild(style);
}
