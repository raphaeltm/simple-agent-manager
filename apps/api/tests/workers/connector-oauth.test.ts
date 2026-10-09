import { createExecutionContext, env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { connectorMcpRoutes } from '../../src/routes/connector-mcp';
import { connectorConsentRoutes, connectorOAuthRoutes } from '../../src/routes/connector-oauth';
import { connectorAdminRoutes, connectorSettingsRoutes } from '../../src/routes/connector-settings';
import {
  authenticateConnectorOAuth,
  createConnectorAuthorizationServer,
  revokeConnectorConnection,
} from '../../src/services/connector-oauth';
import { connectorUrl, updateConnectorSettings } from '../../src/services/connector-settings';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';

const bindings = env as unknown as Env;
const issuer = `https://api.${bindings.BASE_DOMAIN}`;
const verifier = 'a'.repeat(43);
const redirectUris = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/connector_platform_oauth_redirect/connection-123',
  'http://127.0.0.1:3456/callback',
];
let userId: string;
beforeEach(async () => {
  userId = crypto.randomUUID();
  await bindings.DATABASE.prepare('INSERT INTO users (id,email,name,status) VALUES (?,?,?,?)')
    .bind(userId, `${userId}@test.example.com`, 'OAuth user', 'active')
    .run();
  await bindings.DATABASE.prepare(
    "DELETE FROM platform_settings WHERE key LIKE 'connector.%'"
  ).run();
});
async function flow(redirectUri: string, deferExchange = false) {
  const server = await createConnectorAuthorizationServer(bindings);
  const call = async (path: string, body: unknown, form = false) => {
    const request = new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    });
    return (await createConnectorAuthorizationServer(bindings, undefined, request)).fetch(
      request,
      bindings,
      createExecutionContext()
    );
  };
  const registered = await call('/oauth/register', {
    client_name: 'Conformance app',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'sam.read sam.write offline_access',
    state: 'original-state',
    resource: connectorUrl(bindings),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const oauth = server.getOAuthApi(bindings);
  const request = await oauth.parseAuthRequest(new Request(`${issuer}/oauth/authorize?${params}`));
  const consent = await oauth.beginConsent(request);
  const cookie = consent.headers.get('set-cookie')!.split(';')[0]!;
  const approved = await oauth.approveConsent(
    new Request(`${issuer}/api/connector/consent`, { method: 'POST', headers: { Cookie: cookie } }),
    consent.handle
  );
  const connectionId = crypto.randomUUID();
  await bindings.DATABASE.prepare(
    'INSERT INTO connector_oauth_grants (id,user_id,client_id,client_name,scopes,created_at) VALUES (?,?,?,?,?,?)'
  )
    .bind(
      connectionId,
      userId,
      client.client_id,
      'Conformance app',
      JSON.stringify(request.scope),
      new Date().toISOString()
    )
    .run();
  const authorization = await oauth.completeAuthorization({
    request: approved.request,
    userId,
    scope: request.scope,
    metadata: { connectionId },
    props: { connectionId, clientName: 'Conformance app' },
    revokeExistingGrants: false,
  });
  const redirect = new URL(authorization.redirectTo);
  expect(redirect.searchParams.get('iss')).toBe(issuer);
  expect(redirect.searchParams.get('state')).toBe('original-state');
  const exchangeBody = {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code: redirect.searchParams.get('code')!,
    code_verifier: verifier,
    resource: connectorUrl(bindings),
  };
  let tokens = { access_token: '', refresh_token: '' };
  if (!deferExchange) {
    const tokenResponse = await call('/oauth/token', exchangeBody, true);
    expect(tokenResponse.status).toBe(200);
    tokens = (await tokenResponse.json()) as typeof tokens;
  }
  return {
    server,
    call,
    client,
    connectionId,
    tokens,
    oauth,
    request,
    consent,
    cookie,
    exchangeBody,
  };
}
const auth = (token: string) =>
  authenticateConnectorOAuth(
    new Request(connectorUrl(bindings), { headers: { Authorization: `Bearer ${token}` } }),
    bindings
  );
describe('Connector OAuth real Workers/KV conformance', () => {
  it.each(redirectUris)(
    'DCR → S256 consent → form exchange → refresh → revoke: %s',
    async (redirect) => {
      const result = await flow(redirect);
      expect((await auth(result.tokens.access_token))?.userId).toBe(userId);
      const refresh = await result.call(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: result.client.client_id,
          refresh_token: result.tokens.refresh_token,
          resource: connectorUrl(bindings),
        },
        true
      );
      expect(refresh.status).toBe(200);
      const rotated = (await refresh.json()) as { refresh_token: string; access_token: string };
      expect(rotated.refresh_token).not.toBe(result.tokens.refresh_token);
      expect((await auth(rotated.access_token))?.userId).toBe(userId);
      await revokeConnectorConnection(bindings, result.connectionId, userId);
      expect(await auth(rotated.access_token)).toBeNull();
      const dead = await result.call(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: result.client.client_id,
          refresh_token: rotated.refresh_token,
        },
        true
      );
      expect(dead.status).toBe(400);
      expect(((await dead.json()) as { error: string }).error).toBe('invalid_grant');
    }
  );
  it('serves the real MCP catalog and a scoped operation with an OAuth access token', async () => {
    const result = await flow(redirectUris[0]!);
    const app = new Hono<{ Bindings: Env }>().route('/connect/mcp', connectorMcpRoutes);
    const invoke = (body: unknown) =>
      app.fetch(
        new Request(connectorUrl(bindings), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${result.tokens.access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify(body),
        }),
        bindings,
        createExecutionContext()
      );
    const listed = await invoke({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const readMcp = async (response: Response) => {
      const text = await response.text();
      return JSON.parse(
        text.startsWith('event:')
          ? text
              .split('\n')
              .find((line) => line.startsWith('data:'))!
              .slice(5)
              .trim()
          : text
      );
    };
    const catalog = (await readMcp(listed)) as { result: { tools: Array<{ name: string }> } };
    expect(catalog.result.tools).toHaveLength(18);
    const called = await invoke({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'sam_projects_list', arguments: {} },
    });
    expect(called.status).toBe(200);
    expect(await readMcp(called)).toMatchObject({
      result: { structuredContent: { data: expect.anything() } },
    });
  });
  it('atomic refresh admission detects simultaneous replay and denies both resulting token families', async () => {
    const result = await flow(redirectUris[0]!);
    const body = {
      grant_type: 'refresh_token',
      client_id: result.client.client_id,
      refresh_token: result.tokens.refresh_token,
      resource: connectorUrl(bindings),
    };
    const responses = await Promise.all([
      result.call('/oauth/token', body, true),
      result.call('/oauth/token', body, true),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(await auth(result.tokens.access_token)).toBeNull();
    const winner = (await responses.find((response) => response.ok)!.json()) as {
      access_token: string;
    };
    expect(await auth(winner.access_token)).toBeNull();
  });
  it('runs the real consent routes, rejects foreign-origin approvals, and returns a validated denial redirect', async () => {
    const result = await flow(redirectUris[0]!);
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', {
        user: {
          id: userId,
          email: 'user@example.com',
          name: 'User',
          avatarUrl: null,
          role: 'user',
          status: 'active',
        },
        session: { id: 'test-session', token: null, expiresAt: new Date(Date.now() + 60000) },
      });
      await next();
    });
    app.route('/api/connector/consent', connectorConsentRoutes);
    app.route('/', connectorOAuthRoutes);
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as 403)
        : c.json({ error: 'test_failure', message: error.message }, 500)
    );
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: result.client.client_id,
      redirect_uri: redirectUris[0]!,
      scope: 'sam.read sam.write offline_access',
      state: 'consent-state',
      resource: connectorUrl(bindings),
      code_challenge: result.request.codeChallenge!,
      code_challenge_method: 'S256',
    });
    const get = await app.fetch(
      new Request(`${issuer}/api/connector/consent?${query}`),
      bindings,
      createExecutionContext()
    );
    expect(get.status).toBe(200);
    const data = (await get.json()) as { handle: string };
    const cookie = get.headers.get('set-cookie')!.split(';')[0]!;
    const post = (origin: string, approve: boolean) =>
      app.fetch(
        new Request(`${issuer}/api/connector/consent`, {
          method: 'POST',
          headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle: data.handle, approve }),
        }),
        bindings,
        createExecutionContext()
      );
    expect((await post('https://evil.example', true)).status).toBe(403);
    const approved = await post(`https://app.${bindings.BASE_DOMAIN}`, true);
    expect(approved.status).toBe(200);
    const completed = (await approved.json()) as { redirectTo: string };
    expect(new URL(completed.redirectTo).searchParams.get('iss')).toBe(issuer);
    const tokens = await result.call(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: result.client.client_id,
        redirect_uri: redirectUris[0]!,
        resource: connectorUrl(bindings),
        code: new URL(completed.redirectTo).searchParams.get('code')!,
        code_verifier: verifier,
      },
      true
    );
    expect(tokens.status).toBe(200);
    expect(
      (await auth(((await tokens.json()) as { access_token: string }).access_token))?.userId
    ).toBe(userId);
    const deniedGet = await app.fetch(
      new Request(`${issuer}/api/connector/consent?${query}`),
      bindings,
      createExecutionContext()
    );
    const deniedData = (await deniedGet.json()) as { handle: string };
    const denied = await app.fetch(
      new Request(`${issuer}/api/connector/consent`, {
        method: 'POST',
        headers: {
          Origin: `https://app.${bindings.BASE_DOMAIN}`,
          Cookie: deniedGet.headers.get('set-cookie')!.split(';')[0]!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ handle: deniedData.handle, approve: false }),
      }),
      bindings,
      createExecutionContext()
    );
    expect(denied.status).toBe(200);
    const deniedRedirect = new URL(((await denied.json()) as { redirectTo: string }).redirectTo);
    expect(deniedRedirect.searchParams.get('error')).toBe('access_denied');
    expect(deniedRedirect.searchParams.get('state')).toBe('consent-state');
    expect(deniedRedirect.searchParams.get('iss')).toBe(issuer);
  });
  it('enforces the user/admin connection API boundary and uncached read-only settings', async () => {
    const result = await flow(redirectUris[0]!);
    function appFor(id: string, role: 'user' | 'superadmin') {
      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.set('auth', {
          user: {
            id,
            email: 'user@example.com',
            name: 'User',
            avatarUrl: null,
            role,
            status: 'active',
          },
          session: { id: 'test-session', token: null, expiresAt: new Date(Date.now() + 60000) },
        });
        await next();
      });
      app.route('/api/connector', connectorSettingsRoutes);
      app.route('/api/admin/connector', connectorAdminRoutes);
      app.onError((error, c) =>
        error instanceof AppError
          ? c.json(error.toJSON(), error.statusCode as 403)
          : c.json({ error: 'test_failure' }, 500)
      );
      return app;
    }
    const user = appFor(userId, 'user');
    expect((await user.request('/api/admin/connector/settings', {}, bindings)).status).toBe(403);
    const ownerList = await user.request('/api/connector/connections', {}, bindings);
    expect(await ownerList.json()).toMatchObject({ connections: [{ id: result.connectionId }] });
    const attacker = appFor('other-user', 'user');
    expect(
      (
        await attacker.request(
          `/api/connector/connections/${result.connectionId}`,
          { method: 'DELETE' },
          bindings
        )
      ).status
    ).toBe(404);
    const admin = appFor(userId, 'superadmin');
    const patch = await admin.request(
      '/api/admin/connector/settings',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writeEnabled: false }),
      },
      bindings
    );
    expect(patch.status).toBe(200);
    expect((await auth(result.tokens.access_token))?.scopes.has('sam.write')).toBe(false);
    const reset = await admin.request(
      '/api/admin/connector/settings',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writeEnabled: null }),
      },
      bindings
    );
    expect(reset.status).toBe(200);
    expect((await auth(result.tokens.access_token))?.scopes.has('sam.write')).toBe(true);
    expect(
      (
        await admin.request(
          `/api/admin/connector/connections/${result.connectionId}`,
          { method: 'DELETE' },
          bindings
        )
      ).status
    ).toBe(200);
    expect(await auth(result.tokens.access_token)).toBeNull();
  });
  it('serves RFC 7009 revocation without accepting token grants at the alias', async () => {
    const result = await flow(redirectUris[0]!);
    const app = new Hono<{ Bindings: Env }>().route('/', connectorOAuthRoutes);
    const post = (body: Record<string, string>) =>
      app.fetch(
        new Request(`${issuer}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body),
        }),
        bindings,
        createExecutionContext()
      );
    expect(
      (
        await post({
          grant_type: 'refresh_token',
          token: result.tokens.refresh_token,
          client_id: result.client.client_id,
        })
      ).status
    ).toBe(400);
    const response = await post({
      token: result.tokens.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: result.client.client_id,
    });
    expect(response.status).toBe(200);
    expect(await auth(result.tokens.access_token)).toBeNull();
  });
  it('admits at most one simultaneous authorization-code exchange and revokes the replayed family', async () => {
    const result = await flow(redirectUris[0]!, true);
    const responses = await Promise.all([
      result.call('/oauth/token', result.exchangeBody, true),
      result.call('/oauth/token', result.exchangeBody, true),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const winner = (await responses.find((response) => response.ok)!.json()) as {
      access_token: string;
    };
    expect(await auth(winner.access_token)).toBeNull();
  });
  it('bounds public registration bodies, per-IP and global budgets, and expires the idle client index', async () => {
    const app = new Hono<{ Bindings: Env }>().route('/', connectorOAuthRoutes);
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as 429)
        : c.json({ error: 'test_failure', message: error.message }, 500)
    );
    await bindings.DATABASE.prepare('DELETE FROM connector_oauth_registration_budget').run();
    const testEnv = {
      ...bindings,
      CONNECTOR_REGISTRATION_PER_IP_PER_HOUR: '1',
      CONNECTOR_REGISTRATION_GLOBAL_PER_HOUR: '2',
      CONNECTOR_OAUTH_REQUEST_MAX_BYTES: '1024',
    };
    const register = (ip: string, body: unknown) =>
      app.fetch(
        new Request(`${issuer}/oauth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
          body: JSON.stringify(body),
        }),
        testEnv,
        createExecutionContext()
      );
    const body = {
      client_name: 'Legitimate client',
      redirect_uris: [redirectUris[0]],
      token_endpoint_auth_method: 'none',
    };
    expect((await register('192.0.2.1', { ...body, client_name: 'x'.repeat(2048) })).status).toBe(
      413
    );
    await bindings.DATABASE.prepare(
      'INSERT INTO connector_oauth_clients (id,client_name,redirect_hosts,created_at,expires_at) VALUES (?,?,?,?,?)'
    )
      .bind('expired-client', 'Old client', '[]', new Date(0).toISOString(), Date.now() - 1)
      .run();
    expect((await register('192.0.2.2', body)).status).toBe(201);
    expect(
      await bindings.DATABASE.prepare(
        "SELECT id FROM connector_oauth_clients WHERE id='expired-client'"
      ).first()
    ).toBeNull();
    expect((await register('192.0.2.2', body)).status).toBe(429);
    expect((await register('192.0.2.3', body)).status).toBe(201);
    expect((await register('192.0.2.4', body)).status).toBe(429);
    await bindings.DATABASE.prepare('DELETE FROM connector_oauth_registration_budget').run();
    testEnv.CONNECTOR_REGISTRATION_GLOBAL_PER_HOUR = '1';
    const concurrent = await Promise.all([
      register('192.0.2.5', body),
      register('192.0.2.6', body),
      register('192.0.2.7', body),
    ]);
    expect(concurrent.filter((response) => response.status === 201)).toHaveLength(1);
    expect(concurrent.filter((response) => response.status === 429)).toHaveLength(2);

    await bindings.DATABASE.prepare('DELETE FROM connector_oauth_registration_budget').run();
  });
  it('keeps refresh grants usable after temporary installation disablement', async () => {
    const result = await flow(redirectUris[0]!);
    const body = {
      grant_type: 'refresh_token',
      client_id: result.client.client_id,
      refresh_token: result.tokens.refresh_token,
      resource: connectorUrl(bindings),
    };
    await updateConnectorSettings(bindings, { enabled: false }, userId);
    const disabled = await result.call('/oauth/token', body, true);
    expect(await disabled.json()).toMatchObject({ error: 'temporarily_unavailable' });
    await updateConnectorSettings(bindings, { enabled: true }, userId);
    const restored = await result.call('/oauth/token', body, true);
    expect(restored.status).toBe(200);
  });
  it('rejects oversized client metadata before issuing a registration', async () => {
    const oauthServer = await createConnectorAuthorizationServer(bindings);
    for (const body of [
      { client_name: 'x'.repeat(201), redirect_uris: [redirectUris[0]] },
      {
        client_name: 'Bounded',
        redirect_uris: Array.from(
          { length: 11 },
          (_, n) => `http://localhost:${18000 + n}/callback`
        ),
      },
    ]) {
      const response = await oauthServer.fetch(
        new Request(`${issuer}/oauth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, token_endpoint_auth_method: 'none' }),
        }),
        bindings,
        createExecutionContext()
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' });
    }
  });
  it('slides refresh expiry beyond the original absolute lifetime', async () => {
    const result = await flow(redirectUris[0]!);
    const initial = (await result.oauth.listUserGrants(userId)).items.find(
      (grant) => grant.clientId === result.client.client_id
    )!;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now + 20 * 86400000);
      const first = await result.call(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: result.client.client_id,
          refresh_token: result.tokens.refresh_token,
          resource: connectorUrl(bindings),
        },
        true
      );
      expect(first.status).toBe(200);
      const renewed = (await first.json()) as { refresh_token: string };
      const after = (await result.oauth.listUserGrants(userId)).items.find(
        (grant) => grant.clientId === result.client.client_id
      )!;
      expect(after.expiresAt!).toBeGreaterThan(initial.expiresAt!);
      clock.mockReturnValue(now + 40 * 86400000);
      const beyondOriginal = await result.call(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: result.client.client_id,
          refresh_token: renewed.refresh_token,
          resource: connectorUrl(bindings),
        },
        true
      );
      expect(beyondOriginal.status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
  it('OAuth starts real task/session records, reads the task, and revocation returns 401', async () => {
    const result = await flow(redirectUris[0]!);
    const projectId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    await bindings.DATABASE.prepare(
      'INSERT INTO github_installations (id,user_id,installation_id,account_type,account_name) VALUES (?,?,?,?,?)'
    )
      .bind(installationId, userId, installationId, 'User', 'fixture')
      .run();
    await bindings.DATABASE.prepare(
      "INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository,repo_provider,default_branch,default_provider,default_location,default_vm_size,status,created_by) VALUES (?,?,?,?,?,?,'artifacts','main','hetzner','fsn1','small','active',?)"
    )
      .bind(
        projectId,
        userId,
        'OAuth project',
        `oauth-${projectId}`,
        installationId,
        'fixture/project',
        userId
      )
      .run();
    await bindings.DATABASE.prepare(
      "INSERT INTO project_members (project_id,user_id,role,status) VALUES (?,?,'owner','active')"
    )
      .bind(projectId, userId)
      .run();
    await bindings.DATABASE.prepare(
      "INSERT INTO credentials (id,user_id,project_id,provider,credential_type,credential_kind,is_active,encrypted_token,iv) VALUES (?,?,?,'hetzner','cloud-provider','api-key',1,'synthetic-encrypted-credential','synthetic-iv')"
    )
      .bind(crypto.randomUUID(), userId, projectId)
      .run();
    await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(bindings.DATABASE, { schema }), {
      userId,
      projectId,
      includeInstallation: false,
    });
    const start = vi.fn().mockResolvedValue(undefined);
    // Only the external runtime admission boundary is replaced. Task submit, placement,
    // membership, D1 persistence and ProjectData session/message RPCs remain real.
    const taskEnv = {
      ...bindings,
      CF_CONTAINER_ENABLED: 'false',
      TASK_TITLE_GENERATION_ENABLED: 'false',
      TASK_RUNNER: {
        idFromName: bindings.TASK_RUNNER.idFromName.bind(bindings.TASK_RUNNER),
        get: () => ({ start }),
      } as unknown as DurableObjectNamespace,
    };
    const app = new Hono<{ Bindings: Env }>().route('/connect/mcp', connectorMcpRoutes);
    const invoke = (name: string, args: unknown) =>
      app.fetch(
        new Request(connectorUrl(bindings), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${result.tokens.access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        }),
        taskEnv,
        createExecutionContext()
      );
    const decode = async (response: Response) => {
      const text = await response.text();
      return JSON.parse(
        text.startsWith('event:')
          ? text
              .split('\n')
              .find((line) => line.startsWith('data:'))!
              .slice(5)
              .trim()
          : text
      );
    };
    const started = await invoke('sam_chat_start', {
      projectId,
      message: 'Inspect the project and report findings',
      requestKey: 'oauth-task-capability',
    });
    expect(started.status).toBe(200);
    const startedBody = await decode(started);
    expect(startedBody, JSON.stringify(startedBody)).toMatchObject({
      result: {
        structuredContent: { data: { taskId: expect.any(String), sessionId: expect.any(String) } },
      },
    });
    const task = startedBody.result.structuredContent.data as { taskId: string; sessionId: string };
    expect(
      await bindings.DATABASE.prepare(
        'SELECT triggered_by,connector_client_name,chat_session_id FROM tasks WHERE id=?'
      )
        .bind(task.taskId)
        .first()
    ).toMatchObject({
      triggered_by: 'connector',
      connector_client_name: 'Conformance app',
      chat_session_id: task.sessionId,
    });
    expect(start).toHaveBeenCalledTimes(1);
    const read = await invoke('sam_task_get', { projectId, taskId: task.taskId });
    expect(await decode(read)).toMatchObject({
      result: { structuredContent: { data: { id: task.taskId } } },
    });
    await revokeConnectorConnection(bindings, result.connectionId, userId);
    expect((await invoke('sam_task_get', { projectId, taskId: task.taskId })).status).toBe(401);
  });
  it.each([
    { name: 'wrong PKCE verifier', override: { code_verifier: 'z'.repeat(43) } },
    { name: 'wrong resource', override: { resource: 'https://evil.example/mcp' } },
    { name: 'unregistered redirect', override: { redirect_uri: 'https://evil.example/callback' } },
  ])(
    'rejects code exchange with $name without consuming the legitimate code',
    async ({ override }) => {
      const result = await flow(redirectUris[0]!, true);
      const denied = await result.call(
        '/oauth/token',
        { ...result.exchangeBody, ...override },
        true
      );
      expect(denied.status).toBe(400);
      expect((await result.call('/oauth/token', result.exchangeBody, true)).status).toBe(200);
    }
  );
  it('requires S256 PKCE and HTTPS or loopback redirects, and expires idle refresh tokens', async () => {
    const result = await flow(redirectUris[0]!);
    const query = new URLSearchParams({
      client_id: result.client.client_id,
      redirect_uri: redirectUris[0]!,
      response_type: 'code',
      scope: 'sam.read',
      resource: connectorUrl(bindings),
    });
    await expect(
      result.oauth.parseAuthRequest(new Request(`${issuer}/oauth/authorize?${query}`))
    ).rejects.toThrow();
    query.set('code_challenge', 'a'.repeat(43));
    query.set('code_challenge_method', 'plain');
    await expect(
      result.oauth.parseAuthRequest(new Request(`${issuer}/oauth/authorize?${query}`))
    ).rejects.toThrow();
    const denied = await result.call('/oauth/register', {
      client_name: 'Unsafe redirect',
      redirect_uris: ['http://evil.example/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(denied.status).toBe(400);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400000);
    try {
      const expired = await result.call(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: result.client.client_id,
          refresh_token: result.tokens.refresh_token,
        },
        true
      );
      expect(expired.status).toBe(400);
      expect(await expired.json()).toMatchObject({ error: 'invalid_grant' });
    } finally {
      clock.mockRestore();
    }
  });
  it('detects refresh token replay and revokes the entire connection', async () => {
    const result = await flow(redirectUris[0]!);
    const body = {
      grant_type: 'refresh_token',
      client_id: result.client.client_id,
      refresh_token: result.tokens.refresh_token,
      resource: connectorUrl(bindings),
    };
    expect((await result.call('/oauth/token', body, true)).status).toBe(200);
    const replay = await result.call('/oauth/token', body, true);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await auth(result.tokens.access_token)).toBeNull();
  });
  it('rejects cross-user revoke, live suspension, disabling, blocked clients, and wrong audience', async () => {
    const result = await flow(redirectUris[0]!);
    expect(await revokeConnectorConnection(bindings, result.connectionId, 'other-user')).toBe(
      false
    );
    expect((await auth(result.tokens.access_token))?.userId).toBe(userId);
    expect(
      await result.server
        .validateToken(`${issuer}/other`, result.tokens.access_token, bindings)
        .catch(() => null)
    ).toBeNull();
    await bindings.DATABASE.prepare("UPDATE users SET status='suspended' WHERE id=?")
      .bind(userId)
      .run();
    await expect(auth(result.tokens.access_token)).rejects.toThrow('suspended');
    await bindings.DATABASE.prepare("UPDATE users SET status='active' WHERE id=?")
      .bind(userId)
      .run();
    await updateConnectorSettings(bindings, { enabled: false }, userId);
    expect(await auth(result.tokens.access_token)).toBeNull();
    await updateConnectorSettings(bindings, { enabled: true }, userId);
    expect((await auth(result.tokens.access_token))?.userId).toBe(userId);
    await bindings.DATABASE.prepare(
      'INSERT INTO connector_oauth_clients (id,client_name,redirect_hosts,created_at,blocked) VALUES (?,?,?,?,1)'
    )
      .bind(result.client.client_id, 'Conformance app', '[]', new Date().toISOString())
      .run();
    expect(await auth(result.tokens.access_token)).toBeNull();
  });
  it('binds consent to the initiating browser and consumes approval once', async () => {
    const result = await flow(redirectUris[0]!);
    const fresh = await result.oauth.beginConsent(result.request);
    await expect(
      result.oauth.approveConsent(
        new Request(`${issuer}/api/connector/consent`, { method: 'POST' }),
        fresh.handle
      )
    ).rejects.toThrow();
    await expect(
      result.oauth.approveConsent(
        new Request(`${issuer}/api/connector/consent`, {
          method: 'POST',
          headers: { Cookie: result.cookie },
        }),
        result.consent.handle
      )
    ).rejects.toThrow();
  });
  it('publishes bounded discovery and rejects disallowed redirect hosts', async () => {
    await updateConnectorSettings(bindings, { clientRegistration: 'allowlist' }, userId);
    const server = await createConnectorAuthorizationServer(bindings);
    const started = Date.now();
    const response = await server.fetch(
      new Request(`${issuer}/.well-known/oauth-authorization-server`),
      bindings,
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(await response.json()).toMatchObject({
      issuer,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
    });
    const denied = await server.fetch(
      new Request(`${issuer}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Untrusted',
          redirect_uris: ['https://evil.example/callback'],
          token_endpoint_auth_method: 'none',
        }),
      }),
      bindings,
      createExecutionContext()
    );
    expect(denied.status).toBe(400);
  });
});
