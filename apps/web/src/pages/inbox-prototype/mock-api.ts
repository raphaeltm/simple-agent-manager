/**
 * PROTOTYPE ONLY — answers the few API calls the real answer components make, so
 * AttentionAnswerControls, AcpPermissionCard and SecretRequestForm run unmodified against
 * mock data. Installed once, only while the prototype module is loaded in a dev build.
 */
import { findItem } from './model';

/** Last answer per attention marker, so the receipt can quote it. */
export const lastAnswers = new Map<string, string>();
/** ACP interactions answered through the real card. */
export const answeredInteractions = new Set<string>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 350));

let installed = false;

export function installMockApi() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();

    let m = path.match(/\/attention\/([^/]+)\/resolve$/);
    if (m && method === 'POST') {
      const answer = String(JSON.parse(String(init?.body ?? '{}')).answer ?? '');
      lastAnswers.set(decodeURIComponent(m[1] ?? ''), answer);
      return later(json({ resolved: true, alreadyResolved: false, answer }));
    }
    m = path.match(/\/interactions\/([^/]+)\/answer$/);
    if (m && method === 'POST') {
      answeredInteractions.add(decodeURIComponent(m[1] ?? ''));
      return later(json({ accepted: true, state: 'answered' }));
    }
    m = path.match(/\/interactions\/([^/]+)$/);
    if (m) {
      const item = findItem(decodeURIComponent(m[1] ?? ''));
      return later(
        json({
          summary: { interactionId: item?.id, kind: 'permission', state: 'pending' },
          detail: item?.permission ?? null,
        })
      );
    }
    m = path.match(/\/secret-requests\/([^/]+)\/(fulfill|decline)$/);
    if (m && method === 'POST') {
      return later(
        json({
          request: { id: m[1], status: m[2] === 'fulfill' ? 'fulfilled' : 'declined' },
          agentNotified: true,
        })
      );
    }
    // Anything else the shell asks for (session, notifications) is answered empty so the
    // prototype never reaches a real API.
    if (path.startsWith('/api/')) return json({}, path.startsWith('/api/auth') ? 200 : 404);
    return realFetch(input, init);
  };
}
