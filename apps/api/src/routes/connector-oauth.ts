import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as v from 'valibot';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getCurrentWindowStart, rateLimit } from '../middleware/rate-limit';
import { jsonValidator } from '../schemas';
import {
  DEFAULT_CONNECTOR_CLIENT_IDLE_TTL_SECONDS,
  DEFAULT_CONNECTOR_OAUTH_REQUEST_MAX_BYTES,
  DEFAULT_CONNECTOR_REGISTRATION_GLOBAL_PER_HOUR,
  DEFAULT_CONNECTOR_REGISTRATION_PER_IP_PER_HOUR,
} from '../services/connector-limits';
import {
  createConnectorAuthorizationServer,
  isConnectorClientBlocked,
  isLoopbackHost,
} from '../services/connector-oauth';
import { connectorUrl, getConnectorSettings } from '../services/connector-settings';

export const connectorOAuthRoutes = new Hono<{ Bindings: Env }>();
connectorOAuthRoutes.use('/oauth/*', async (c, next) =>
  bodyLimit({
    maxSize: parsePositiveInt(
      c.env.CONNECTOR_OAUTH_REQUEST_MAX_BYTES,
      DEFAULT_CONNECTOR_OAUTH_REQUEST_MAX_BYTES
    ),
    onError: (c) =>
      c.json({ error: 'invalid_request', message: 'OAuth request body too large' }, 413),
  })(c, next)
);
connectorOAuthRoutes.use('/oauth/register', async (c, next) =>
  rateLimit({
    limit: parsePositiveInt(
      c.env.CONNECTOR_REGISTRATION_PER_IP_PER_HOUR,
      DEFAULT_CONNECTOR_REGISTRATION_PER_IP_PER_HOUR
    ),
    keyPrefix: 'connector-dcr',
    useIp: true,
  })(c, next)
);
connectorOAuthRoutes.use('/oauth/register', async (c, next) => {
  const windowSeconds = 3600;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const limit = parsePositiveInt(
    c.env.CONNECTOR_REGISTRATION_GLOBAL_PER_HOUR,
    DEFAULT_CONNECTOR_REGISTRATION_GLOBAL_PER_HOUR
  );
  const admission = await c.env.DATABASE.prepare(
    `INSERT INTO connector_oauth_registration_budget (id,window_start,used) VALUES (1,?,1)
    ON CONFLICT(id) DO UPDATE SET window_start=excluded.window_start,used=CASE WHEN connector_oauth_registration_budget.window_start=excluded.window_start THEN connector_oauth_registration_budget.used+1 ELSE 1 END
    WHERE connector_oauth_registration_budget.window_start<>excluded.window_start OR connector_oauth_registration_budget.used<?`
  )
    .bind(windowStart, limit)
    .run();
  if (!admission.meta.changes) {
    c.header(
      'Retry-After',
      String(Math.max(1, windowStart + windowSeconds - Math.floor(Date.now() / 1000)))
    );
    throw errors.tooManyRequests('Client registration budget exhausted; try again later');
  }
  await c.env.DATABASE.prepare(
    'DELETE FROM connector_oauth_clients WHERE expires_at IS NOT NULL AND expires_at<=?'
  )
    .bind(Date.now())
    .run();
  await next();
});

connectorOAuthRoutes.get('/oauth/authorize', async (c) => {
  if (!(await getConnectorSettings(c.env)).enabled)
    throw errors.forbidden('Connector disabled by the administrator');
  // Parse before redirecting to the UI: never display or redirect to unvalidated client metadata.
  await (
    await createConnectorAuthorizationServer(c.env)
  )
    .getOAuthApi(c.env)
    .parseAuthRequest(c.req.raw);
  const consent = new URL(`https://app.${c.env.BASE_DOMAIN}/oauth/consent`);
  consent.searchParams.set('request', new URL(c.req.url).searchParams.toString());
  return c.redirect(consent.toString());
});
connectorOAuthRoutes.all('/.well-known/oauth-protected-resource/connect/mcp', (c) =>
  c.json({
    resource: connectorUrl(c.env),
    authorization_servers: [`https://api.${c.env.BASE_DOMAIN}`],
    scopes_supported: ['sam.read', 'sam.write'],
    bearer_methods_supported: ['header'],
  })
);
async function protocol(c: Context<{ Bindings: Env }>) {
  const server = await createConnectorAuthorizationServer(c.env, undefined, c.req.raw);
  let request = c.req.raw;
  if (new URL(request.url).pathname === '/oauth/revoke') {
    if (request.method === 'POST') {
      if (
        request.headers.get('Content-Type')?.split(';')[0]?.trim() !==
        'application/x-www-form-urlencoded'
      )
        return c.json(
          { error: 'invalid_request', error_description: 'Use application/x-www-form-urlencoded' },
          400
        );
      const form = await request.clone().formData();
      if (form.has('grant_type') || !form.get('token'))
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'A revocation requires token and no grant_type',
          },
          400
        );
    }
    const url = new URL(request.url);
    url.pathname = '/oauth/token';
    request = new Request(url, request);
  }
  const response = await server.fetch(
    request,
    c.env,
    c.executionCtx as unknown as ExecutionContext
  );
  if (c.req.path === '/oauth/register' && response.ok) {
    const client = v.parse(
      v.object({
        client_id: v.string(),
        client_name: v.optional(v.string()),
        redirect_uris: v.array(v.pipe(v.string(), v.url())),
      }),
      await response.clone().json()
    );
    await c.env.DATABASE.prepare(
      'INSERT OR IGNORE INTO connector_oauth_clients (id,client_name,redirect_hosts,created_at,expires_at) VALUES (?,?,?,?,?)'
    )
      .bind(
        client.client_id,
        client.client_name ?? 'Unnamed app',
        JSON.stringify(client.redirect_uris.map((uri) => new URL(uri).hostname)),
        new Date().toISOString(),
        Date.now() +
          parsePositiveInt(
            c.env.CONNECTOR_CLIENT_IDLE_TTL_SECONDS,
            DEFAULT_CONNECTOR_CLIENT_IDLE_TTL_SECONDS
          ) *
            1000
      )
      .run();
  }
  if (c.req.path === '/.well-known/oauth-authorization-server' && response.ok) {
    const metadata = v.parse(v.record(v.string(), v.unknown()), await response.json());
    metadata.revocation_endpoint = `https://api.${c.env.BASE_DOMAIN}/oauth/revoke`;
    return c.json(metadata, 200, { 'Cache-Control': 'no-store' });
  }
  return response;
}
connectorOAuthRoutes.all('/.well-known/oauth-authorization-server', protocol);
connectorOAuthRoutes.all('/oauth/token', protocol);
connectorOAuthRoutes.all('/oauth/register', protocol);
connectorOAuthRoutes.all('/oauth/revoke', protocol);

export const connectorConsentRoutes = new Hono<{ Bindings: Env }>();
connectorConsentRoutes.use('*', requireAuth(), requireApproved());
connectorConsentRoutes.get('/', async (c) => {
  const settings = await getConnectorSettings(c.env);
  if (!settings.enabled) throw errors.forbidden('Connector disabled by the administrator');
  const oauth = (await createConnectorAuthorizationServer(c.env, settings)).getOAuthApi(c.env);
  const authorizationUrl = new URL(`https://api.${c.env.BASE_DOMAIN}/oauth/authorize`);
  for (const [name, value] of new URL(c.req.url).searchParams) {
    authorizationUrl.searchParams.append(name, value);
  }
  const request = await oauth.parseAuthRequest(new Request(authorizationUrl));
  if (request.codeChallengeMethod !== 'S256' || !request.codeChallenge)
    throw errors.badRequest('S256 PKCE is required');
  if (await isConnectorClientBlocked(c.env, request.clientId))
    throw errors.forbidden('This client is blocked by the administrator');
  if (!settings.writeEnabled)
    request.scope = request.scope.filter((scope) => scope !== 'sam.write');
  const client = await oauth.lookupClient(request.clientId);
  const transaction = await oauth.beginConsent(request);
  transaction.headers.forEach((value, key) => c.header(key, value));
  const redirectHost = new URL(request.redirectUri).hostname;
  return c.json({
    handle: transaction.handle,
    clientName: client?.clientName ?? 'Unnamed app',
    redirectHost,
    loopback: isLoopbackHost(redirectHost),
    scopes: request.scope,
  });
});
connectorConsentRoutes.post(
  '/',
  jsonValidator(v.object({ handle: v.pipe(v.string(), v.minLength(1)), approve: v.boolean() })),
  async (c) => {
    // Cross-origin consent must only be submitted by SAM's own UI, even with ambient cookies.
    if (c.req.header('Origin') !== `https://app.${c.env.BASE_DOMAIN}`)
      throw errors.forbidden('Invalid consent origin');
    const settings = await getConnectorSettings(c.env);
    if (!settings.enabled) throw errors.forbidden('Connector disabled by the administrator');
    const oauth = (await createConnectorAuthorizationServer(c.env, settings)).getOAuthApi(c.env);
    const body = c.req.valid('json');
    if (!body.approve) {
      const denied = await oauth.denyConsent(c.req.raw, body.handle);
      denied.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'location') c.header(key, value);
      });
      return c.json({ redirectTo: denied.redirectTo });
    }
    const approved = await oauth.approveConsent(c.req.raw, body.handle);
    const request = approved.request;
    if (await isConnectorClientBlocked(c.env, request.clientId))
      throw errors.forbidden('This client is blocked by the administrator');
    const scope = request.scope.filter((scope) => settings.writeEnabled || scope !== 'sam.write');
    const client = await oauth.lookupClient(request.clientId);
    const clientName = client?.clientName ?? 'Unnamed app';
    await c.env.DATABASE.prepare(
      'INSERT OR IGNORE INTO connector_oauth_clients (id,client_name,redirect_hosts,created_at) VALUES (?,?,?,?)'
    )
      .bind(
        request.clientId,
        clientName,
        JSON.stringify(
          (client?.redirectUris ?? [request.redirectUri]).map((uri) => new URL(uri).hostname)
        ),
        new Date().toISOString()
      )
      .run();
    const connectionId = crypto.randomUUID();
    const userId = c.get('auth').user.id;
    await c.env.DATABASE.prepare(
      'INSERT INTO connector_oauth_grants (id,user_id,client_id,client_name,scopes,created_at) VALUES (?,?,?,?,?,?)'
    )
      .bind(
        connectionId,
        userId,
        request.clientId,
        clientName,
        JSON.stringify(scope),
        new Date().toISOString()
      )
      .run();
    let result: { redirectTo: string };
    try {
      result = await oauth.completeAuthorization({
        request,
        userId,
        scope,
        metadata: { connectionId, clientName },
        props: { connectionId, clientName },
        revokeExistingGrants: false,
      });
    } catch (error) {
      await c.env.DATABASE.prepare('UPDATE connector_oauth_grants SET revoked_at=? WHERE id=?')
        .bind(new Date().toISOString(), connectionId)
        .run();
      throw error;
    }
    approved.headers.forEach((value, key) => c.header(key, value));
    return c.json(result);
  }
);
// Protocol validation errors must be safe JSON rather than the library's exception text.
for (const router of [connectorOAuthRoutes, connectorConsentRoutes])
  router.onError((error, c) => {
    if (error instanceof AuthorizationError)
      return c.json({ error: 'invalid_request', message: error.message }, 400);
    throw error;
  });
