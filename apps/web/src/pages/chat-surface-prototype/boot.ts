/**
 * PROTOTYPE ONLY — opening `/prototype/chat-surface` on the dev server turns the in-browser
 * mock API on for this tab and redirects to the real project chat page. Imported first in
 * `main.tsx` so `fetch` and `WebSocket` are patched before any app module runs. Dev builds only.
 * Remove before merge to main.
 */
import { CHAT_SURFACE_PROTOTYPE_URL, installChatSurfaceMocks } from './mock-api';
import { injectChatSurfacePrototypeStyles } from './prototype-styles';

const FLAG = 'sam-proto-chat-surface';

if (import.meta.env.DEV) {
  if (window.location.pathname === '/prototype/chat-surface') {
    window.sessionStorage.setItem(FLAG, '1');
    window.history.replaceState(null, '', CHAT_SURFACE_PROTOTYPE_URL);
  }
  if (window.sessionStorage.getItem(FLAG) === '1') {
    installChatSurfaceMocks();
    injectChatSurfacePrototypeStyles();
  }
}
