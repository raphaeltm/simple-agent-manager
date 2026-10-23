import {
  MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
  WORKLOAD_IDENTITY_AUDIENCE_MAX_LENGTH,
  type WorkloadIdentityClaims,
  WorkloadIdentityClaimsSchema,
} from '@simple-agent-manager/shared';
import { calculateJwkThumbprint, exportJWK, importPKCS8, importSPKI, SignJWT } from 'jose';
import * as v from 'valibot';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveAdminSettingDetails } from './admin-settings';

// Separate issuer isolates external identities from every internal SAM verifier,
// even though installation-managed signing material is reused.
export function workloadIdentityIssuer(env: Env): string {
  return `https://api.${env.BASE_DOMAIN}/oidc`;
}

export async function workloadIdentityLifetime(env: Env): Promise<number> {
  const { value: ttl } = await resolveAdminSettingDetails(
    env,
    'operations.workloadIdentityTokenTtlSeconds'
  );
  if (
    typeof ttl !== 'number' ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS
  ) {
    throw new Error('Invalid workload identity lifetime configuration');
  }
  return ttl;
}

export function workloadIdentitySubject(claims: WorkloadIdentityClaims): string {
  // Encode each ID independently so delimiters can never change subject meaning.
  return `project:${encodeURIComponent(claims.project_id)}:user:${encodeURIComponent(claims.user_id)}:profile:${encodeURIComponent(claims.agent_profile_id ?? 'none')}`;
}

const internalAudiences = new Set([
  'workspace-terminal',
  'workspace-callback',
  'node-management',
  'port-access',
  'local-forward',
]);
export function validateWorkloadAudience(audience: string): void {
  if (
    !audience ||
    audience !== audience.trim() ||
    audience.length > WORKLOAD_IDENTITY_AUDIENCE_MAX_LENGTH ||
    /[\p{Cc}\s]/u.test(audience) ||
    internalAudiences.has(audience)
  ) {
    throw errors.badRequest(
      'OIDC audience must be a nonempty external audience without whitespace'
    );
  }
}

export async function getWorkloadJWKS(env: Env) {
  const key = await exportJWK(await importSPKI(env.JWT_PUBLIC_KEY, 'RS256'));
  return { keys: [{ ...key, kid: await calculateJwkThumbprint(key), use: 'sig', alg: 'RS256' }] };
}

export function getWorkloadDiscovery(env: Env) {
  const issuer = workloadIdentityIssuer(env);
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    claims_supported: [
      'iss',
      'sub',
      'aud',
      'iat',
      'exp',
      'jti',
      'type',
      ...Object.keys(WorkloadIdentityClaimsSchema.entries),
    ],
  };
}

export async function signWorkloadIdentityToken(
  env: Env,
  input: WorkloadIdentityClaims,
  audience: string
): Promise<string> {
  validateWorkloadAudience(audience);
  const claims = v.parse(WorkloadIdentityClaimsSchema, input);
  const ttl = await workloadIdentityLifetime(env);
  const { keys } = await getWorkloadJWKS(env);
  const key = keys[0];
  if (!key) throw new Error('Workload signing key is unavailable');
  return new SignJWT({ ...claims, type: 'workload-identity' })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuer(workloadIdentityIssuer(env))
    .setSubject(workloadIdentitySubject(claims))
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(crypto.randomUUID())
    .sign(await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256'));
}
