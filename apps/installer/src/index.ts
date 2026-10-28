import { boundedBody, json, randomSecret, sessionCookie, sessionId } from './security';
import type { Env } from './types';
export { InstallerSession } from './session';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (url.origin !== env.APP_ORIGIN)
        return new Response('Wrong installer origin', { status: 421 });
      if (url.pathname === '/api/config')
        response = json({
          configured: !!(env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET),
          sourceUrl: env.SOURCE_URL,
          docsUrl: env.DOCS_URL,
          sha: env.BUILD_SHA,
        });
      else if (url.pathname === '/health')
        response = json({
          ok: true,
          sha: env.BUILD_SHA,
          oauthConfigured: !!(env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET),
        });
      else if (url.pathname === '/oauth/start' && request.method === 'POST') {
        if (request.headers.get('Origin') !== env.APP_ORIGIN)
          return json({ error: 'Forbidden' }, 403);
        if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET)
          return json({ error: 'Cloudflare sign-in is not configured yet.' }, 503);
        const id = randomSecret();
        const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
        const start = await stub.fetch(new Request('https://session/start'));
        if (!start.ok) response = start;
        else {
          const data = (await start.json()) as { url: string };
          response = new Response(null, {
            status: 303,
            headers: {
              Location: data.url,
              'Set-Cookie': sessionCookie(env.APP_ORIGIN, id, Number(env.SESSION_TTL_SECONDS)),
            },
          });
        }
      } else if (
        url.pathname === '/oauth/callback' ||
        url.pathname.startsWith('/api/session/') ||
        url.pathname === '/handoff'
      ) {
        const id = sessionId(request, env.APP_ORIGIN);
        if (!id) response = json({ error: 'Your installer session expired. Sign in again.' }, 401);
        else {
          const callback = url.pathname === '/oauth/callback';
          const path = callback
            ? '/callback'
            : url.pathname === '/handoff'
              ? '/handoff'
              : url.pathname.slice('/api/session'.length);
          if (
            !callback &&
            (path === '/status'
              ? request.method !== 'GET'
              : request.method !== 'POST' || request.headers.get('Origin') !== env.APP_ORIGIN)
          )
            return json({ error: 'Forbidden' }, 403);
          if (!['/callback', '/status', '/install', '/finish', '/handoff'].includes(path))
            return json({ error: 'Not found' }, 404);
          if (Number(request.headers.get('content-length') || 0) > 4096)
            return json({ error: 'Request too large' }, 413);
          const body = !callback && request.method === 'POST' ? await boundedBody(request) : '';
          if (body === null) return json({ error: 'Request too large' }, 413);
          const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
          response = await stub.fetch(
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
          if (callback)
            response = new Response(null, {
              status: 303,
              headers: { Location: response.ok ? '/' : '/?error=authorization' },
            });
          if (path === '/finish' || (path === '/handoff' && response.ok)) {
            response = new Response(response.body, response);
            response.headers.set('Set-Cookie', sessionCookie(env.APP_ORIGIN, '', 0));
          }
        }
      } else response = await env.ASSETS.fetch(request);
    } catch {
      response = json(
        { error: 'The installer could not complete this request. Please retry.' },
        500
      );
    }
    response = new Response(response.body, response);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    if (!response.headers.has('Content-Security-Policy'))
      response.headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self' https://dash.cloudflare.com; frame-ancestors 'none'; base-uri 'none'"
      );
    return response;
  },
};
