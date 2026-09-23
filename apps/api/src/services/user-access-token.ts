import * as v from 'valibot';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { getBetterAuthAccountIdForProvider } from './better-auth-account';

type OAuthProviderId = 'github' | 'gitlab';
type UserAccessTokenLockBinding = NonNullable<
  Env['GITHUB_USER_ACCESS_TOKEN_LOCK'] | Env['GITLAB_USER_ACCESS_TOKEN_LOCK']
>;

const lockedTokenResponseSchema = v.object({
  accessToken: v.nullable(v.string()),
  accessTokenExpiresAt: v.nullable(v.string()),
  scopes: v.optional(v.array(v.string())),
});

export async function getBetterAuthAccessTokenForProvider(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  providerId: OAuthProviderId
) {
  const accountId = await getBetterAuthAccountIdForProvider(env, userId, providerId);
  if (!accountId) {
    return null;
  }

  const auth = await createAuth(env);
  return auth.api.getAccessToken({
    ...(headers ? { headers } : {}),
    body: { accountId, userId },
  });
}

export async function requestLockedUserAccessToken(
  binding: UserAccessTokenLockBinding,
  endpoint: string,
  headers: Headers | undefined,
  userId: string,
  flow: string,
  validationContext: string
) {
  const id = binding.idFromName(userId);
  const stub = binding.get(id);
  const response = await stub.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      flow,
      ...(headers ? { headers: Array.from(headers.entries()) } : {}),
    }),
  });

  if (!response.ok) {
    return { token: null, status: response.status };
  }

  return {
    token: await readResponseJson(response, lockedTokenResponseSchema, validationContext),
    status: response.status,
  };
}
