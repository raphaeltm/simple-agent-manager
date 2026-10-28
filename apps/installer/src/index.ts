import { boundedBody, json, randomSecret, sessionCookie, sessionId } from './security';
import type { Env } from './types';
export { InstallerSession } from './session';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.APP_ORIGIN)
      return new Response('Wrong installer origin', { status: 421 });
    let response: Response;
    try {
      response = await routeRequest(request, env, url);
    } catch {
      response = json(
        { error: 'The installer could not complete this request. Please retry.' },
        500
      );
    }
    return secureResponse(response);
  },
};
async function routeRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/config')
    return json({
      configured: !!(env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET),
      sourceUrl: env.SOURCE_URL,
      docsUrl: env.DOCS_URL,
      sha: env.BUILD_SHA,
      fullInstaller: !!env.INSTALL_SOURCE_COMMIT,
    });
  if (url.pathname === '/health')
    return json({
      ok: true,
      sha: env.BUILD_SHA,
      oauthConfigured: !!(env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET),
    });
  if (url.pathname === '/oauth/start' && request.method === 'POST') return startOAuth(request, env);
  if (
    url.pathname === '/oauth/callback' ||
    url.pathname.startsWith('/api/session/') ||
    url.pathname === '/handoff'
  )
    return sessionRequest(request, env, url);
  return env.ASSETS.fetch(request);
}
async function startOAuth(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Origin') !== env.APP_ORIGIN) return json({ error: 'Forbidden' }, 403);
  if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET)
    return json({ error: 'Cloudflare sign-in is not configured yet.' }, 503);
  const id = randomSecret();
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  const start = await stub.fetch(new Request('https://session/start'));
  if (!start.ok) return start;
  else {
    const data = (await start.json()) as { url: string };
    return new Response(null, {
      status: 303,
      headers: {
        Location: data.url,
        'Set-Cookie': sessionCookie(env.APP_ORIGIN, id, Number(env.SESSION_TTL_SECONDS)),
      },
    });
  }
}
async function sessionRequest(request: Request, env: Env, url: URL): Promise<Response> {
  let response: Response;
  const id = sessionId(request, env.APP_ORIGIN);
  if (!id) return json({ error: 'Your installer session expired. Sign in again.' }, 401);
  const callback = url.pathname === '/oauth/callback';
  const path = callback
    ? '/callback'
    : url.pathname === '/handoff'
      ? '/handoff'
      : url.pathname.slice('/api/session'.length);
  const rejected = validateSessionRequest(request, env, path, callback);
  if (rejected) return rejected;
  const body = !callback && request.method === 'POST' ? await boundedBody(request) : '';
  if (body === null) return json({ error: 'Request too large' }, 413);
  response = await forwardSession(request, env, url, id, path, callback, body);
  if (callback)
    response = new Response(null, {
      status: 303,
      headers: { Location: response.ok ? '/' : '/?error=authorization' },
    });
  if (path === '/finish') {
    response = new Response(response.body, response);
    response.headers.set('Set-Cookie', sessionCookie(env.APP_ORIGIN, '', 0));
  }

  return response;
}
async function forwardSession(
  request: Request,
  env: Env,
  url: URL,
  id: string,
  path: string,
  callback: boolean,
  body: string
): Promise<Response> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  return stub.fetch(
    new Request(`https://session${path}`, {
      method: callback ? 'POST' : request.method,
      headers: { 'Content-Type': 'application/json' },
      body: callback
        ? JSON.stringify({
            code: url.searchParams.get('code'),
            state: url.searchParams.get('state'),
          })
        : request.method === 'POST'
          ? body
          : undefined,
    })
  );
}
function secureResponse(response: Response): Response {
  response = new Response(response.body, response);
  response.headers.set('Cache-Control', 'no-store');
  // HTML form POSTs under no-referrer send Origin:null, defeating exact-origin CSRF checks.
  // strict-origin preserves the origin while withholding paths and callback queries.
  response.headers.set('Referrer-Policy', 'strict-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (!response.headers.has('Content-Security-Policy'))
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self' https://dash.cloudflare.com; frame-ancestors 'none'; base-uri 'none'"
    );
  return response;
}

function validateSessionRequest(
  request: Request,
  env: Env,
  path: string,
  callback: boolean
): Response | undefined {
  if (
    !callback &&
    (path === '/status'
      ? request.method !== 'GET'
      : request.method !== 'POST' || request.headers.get('Origin') !== env.APP_ORIGIN)
  )
    return json({ error: 'Forbidden' }, 403);
  if (
    ![
      '/callback',
      '/status',
      '/zones',
      '/preview',
      '/reconcile-cleanup',
      '/install',
      '/finish',
      '/handoff',
    ].includes(path)
  )
    return json({ error: 'Not found' }, 404);
  if (Number(request.headers.get('content-length') || 0) > 4096)
    return json({ error: 'Request too large' }, 413);

  return undefined;
}
