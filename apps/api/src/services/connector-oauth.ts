import { OAuthAuthorizationServer, OAuthError } from '@cloudflare/workers-oauth-provider';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import type { Actor, OperationScope } from '../operations/types';
import {
  DEFAULT_CONNECTOR_CLIENT_IDLE_TTL_SECONDS,
  DEFAULT_CONNECTOR_CLIENT_NAME_MAX_LENGTH,
  DEFAULT_CONNECTOR_REDIRECT_URI_MAX_COUNT,
} from './connector-limits';
import { type ConnectorSettings, connectorUrl, getConnectorSettings } from './connector-settings';
import { assertSessionUserApproved } from './signup-approval';

export interface ConnectorOAuthProps {
  connectionId: string;
  clientName: string;
}
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
export async function isConnectorClientBlocked(env: Env, clientId: string): Promise<boolean> {
  return Boolean(
    await env.DATABASE.prepare('SELECT id FROM connector_oauth_clients WHERE id=? AND blocked=1')
      .bind(clientId)
      .first()
  );
}
export async function createConnectorAuthorizationServer(
  env: Env,
  settings?: ConnectorSettings,
  request?: Request
) {
  const config = settings ?? (await getConnectorSettings(env));
  let refreshHash: string | undefined;
  if (request?.method === 'POST' && new URL(request.url).pathname === '/oauth/token') {
    const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim();
    const form =
      contentType === 'application/x-www-form-urlencoded'
        ? await request.clone().formData()
        : new FormData();
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token')) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(String(form.get('refresh_token') ?? ''))
      );
      refreshHash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }
  }
  return new OAuthAuthorizationServer<Env>({
    issuer: `https://api.${env.BASE_DOMAIN}`,
    resources: [connectorUrl(env)],
    authorizeEndpoint: '/oauth/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: config.accessTokenTtlSeconds,
    refreshTokenTTL: config.refreshTokenTtlSeconds,
    refreshTokenIdleTTL: config.refreshTokenTtlSeconds,
    scopesSupported: ['sam.read', 'sam.write', 'offline_access'],
    clientIdMetadataDocumentEnabled: false,
    clientRegistrationTTL: parsePositiveInt(
      env.CONNECTOR_CLIENT_IDLE_TTL_SECONDS,
      DEFAULT_CONNECTOR_CLIENT_IDLE_TTL_SECONDS
    ),
    clientRegistrationCallback: ({ clientMetadata }) => {
      if (
        (typeof clientMetadata.client_name === 'string' ? clientMetadata.client_name.length : 0) >
          parsePositiveInt(
            env.CONNECTOR_CLIENT_NAME_MAX_LENGTH,
            DEFAULT_CONNECTOR_CLIENT_NAME_MAX_LENGTH
          ) ||
        (Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris.length : 0) >
          parsePositiveInt(
            env.CONNECTOR_REDIRECT_URI_MAX_COUNT,
            DEFAULT_CONNECTOR_REDIRECT_URI_MAX_COUNT
          )
      )
        return {
          code: 'invalid_client_metadata',
          description: 'Client name or redirect URI count exceeds the registration limit',
          status: 400,
        };

      if (!config.enabled)
        return {
          code: 'access_denied',
          description: 'Connector disabled by the administrator',
          status: 403,
        };
      if (config.clientRegistration === 'allowlist') {
        const redirects = clientMetadata.redirect_uris;
        if (
          !Array.isArray(redirects) ||
          redirects.some((uri) => {
            try {
              const host = new URL(String(uri)).hostname;
              return (
                !config.allowedRedirectHosts.includes(host) &&
                !(isLoopbackHost(host) && config.allowedRedirectHosts.includes('loopback'))
              );
            } catch {
              return true;
            }
          })
        )
          return { description: 'Redirect host is not allowed by the administrator' };
      }
    },
    tokenExchangeCallback: async (options) => {
      const props = options.props as ConnectorOAuthProps;
      const row = await env.DATABASE.prepare(
        'SELECT revoked_at FROM connector_oauth_grants WHERE id=? AND user_id=?'
      )
        .bind(props.connectionId, options.userId)
        .first<{ revoked_at: string | null }>();
      if (!config.enabled)
        throw new OAuthError('temporarily_unavailable', {
          description:
            'Connector disabled by the administrator; retain the connection and retry later',
        });
      if (!row || row.revoked_at || (await isConnectorClientBlocked(env, options.clientId)))
        throw new OAuthError('invalid_grant', { description: 'Connection is disabled or revoked' });
      const user = await env.DATABASE.prepare('SELECT role,status FROM users WHERE id=?')
        .bind(options.userId)
        .first<{ role: string; status: string }>();
      if (!user) throw new OAuthError('invalid_grant', { description: 'Account unavailable' });
      try {
        await assertSessionUserApproved(env, user);
      } catch {
        throw new OAuthError('invalid_grant', { description: 'Account unavailable' });
      }
      if (options.grantType === 'authorization_code') {
        const admitted = await env.DATABASE.prepare(
          'UPDATE connector_oauth_grants SET oauth_grant_id=? WHERE id=? AND oauth_grant_id IS NULL AND revoked_at IS NULL'
        )
          .bind(options.grantId, props.connectionId)
          .run();
        if (!admitted.meta.changes) {
          await env.DATABASE.prepare('UPDATE connector_oauth_grants SET revoked_at=? WHERE id=?')
            .bind(new Date().toISOString(), props.connectionId)
            .run();
          throw new OAuthError('invalid_grant', {
            description: 'Authorization code has already been exchanged; reconnect the app',
          });
        }
      }
      if (options.grantType === 'refresh_token') {
        // The provider tolerates reuse of the immediately previous token for KV propagation.
        // Our D1 admission makes successful refreshes single-use across regions instead.
        if (!refreshHash)
          throw new OAuthError('invalid_grant', { description: 'Refresh request context missing' });
        const used = await env.DATABASE.prepare(
          'INSERT OR IGNORE INTO connector_oauth_refresh_uses (token_hash,connection_id,expires_at) VALUES (?,?,?)'
        )
          .bind(refreshHash, props.connectionId, Date.now() + config.refreshTokenTtlSeconds * 1000)
          .run();
        if (!used.meta.changes) {
          await env.DATABASE.prepare('UPDATE connector_oauth_grants SET revoked_at=? WHERE id=?')
            .bind(new Date().toISOString(), props.connectionId)
            .run();
          throw new OAuthError('invalid_grant', {
            description: 'Refresh token has already been used; reconnect the app',
          });
        }
        await env.DATABASE.prepare('DELETE FROM connector_oauth_refresh_uses WHERE expires_at<?')
          .bind(Date.now())
          .run();
      }
      await env.DATABASE.prepare(
        'UPDATE connector_oauth_grants SET oauth_grant_id=?,last_used_at=? WHERE id=?'
      )
        .bind(options.grantId, new Date().toISOString(), props.connectionId)
        .run();
      await env.DATABASE.prepare(
        'UPDATE connector_oauth_clients SET expires_at=? WHERE id=? AND expires_at IS NOT NULL'
      )
        .bind(
          Date.now() +
            parsePositiveInt(
              env.CONNECTOR_CLIENT_IDLE_TTL_SECONDS,
              DEFAULT_CONNECTOR_CLIENT_IDLE_TTL_SECONDS
            ) *
              1000,
          options.clientId
        )
        .run();
      return {
        accessTokenScope: options.requestedScope.filter(
          (scope) => config.writeEnabled || scope !== 'sam.write'
        ),
      };
    },
  });
}
export async function authenticateConnectorOAuth(
  request: Request,
  env: Env,
  settings?: ConnectorSettings
): Promise<Actor | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match?.[1] || match[1].startsWith('sam_pat_')) return null;
  const config = settings ?? (await getConnectorSettings(env));
  if (!config.enabled) return null;
  const server = await createConnectorAuthorizationServer(env, config);
  const token = await server.validateToken<ConnectorOAuthProps>(connectorUrl(env), match[1], env);
  if (!token || (await isConnectorClientBlocked(env, token.clientId))) return null;
  const grant = await env.DATABASE.prepare(
    'SELECT id FROM connector_oauth_grants WHERE id=? AND user_id=? AND revoked_at IS NULL'
  )
    .bind(token.props.connectionId, token.userId)
    .first();
  if (!grant) return null;
  const user = await env.DATABASE.prepare('SELECT role,status FROM users WHERE id=?')
    .bind(token.userId)
    .first<{ role: string; status: string }>();
  if (!user || user.status === 'system') return null;
  await assertSessionUserApproved(env, user);
  await env.DATABASE.prepare('UPDATE connector_oauth_grants SET last_used_at=? WHERE id=?')
    .bind(new Date().toISOString(), token.props.connectionId)
    .run();
  return {
    userId: token.userId,
    via: 'connector',
    clientId: token.clientId,
    clientName: token.props.clientName,
    scopes: new Set(
      token.scope.filter(
        (scope): scope is OperationScope =>
          scope === 'sam.read' || (scope === 'sam.write' && config.writeEnabled)
      )
    ),
  };
}
export async function revokeConnectorConnection(
  env: Env,
  id: string,
  userId?: string
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT user_id,oauth_grant_id FROM connector_oauth_grants WHERE id=?${userId ? ' AND user_id=?' : ''}`
  )
    .bind(...(userId ? [id, userId] : [id]))
    .first<{ user_id: string; oauth_grant_id: string | null }>();
  if (!row) return false;
  // D1 gate first: immediate rejection even while the provider's KV deletion propagates.
  await env.DATABASE.prepare('UPDATE connector_oauth_grants SET revoked_at=? WHERE id=?')
    .bind(new Date().toISOString(), id)
    .run();
  if (row.oauth_grant_id)
    await (
      await createConnectorAuthorizationServer(env)
    )
      .getOAuthApi(env)
      .revokeGrant(row.oauth_grant_id, row.user_id);
  return true;
}
