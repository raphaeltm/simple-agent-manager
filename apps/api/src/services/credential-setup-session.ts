/**
 * Service wrapper for the per-session CredentialSetupSession Durable Object.
 *
 * Resolves the DO stub from a setup session id (idFromName — the id is also the
 * sandbox id) and forwards typed RPC calls. All setup-session routes and the
 * cron sweep go through here.
 */
import type {
  CreateSetupSessionParams,
  CredentialSetupSession,
  SetupSessionStateResult,
} from '../durable-objects/credential-setup-session';
import type { Env } from '../env';

function getStub(env: Env, sessionId: string): DurableObjectStub<CredentialSetupSession> {
  if (!env.CREDENTIAL_SETUP_SESSION) {
    throw new Error('CREDENTIAL_SETUP_SESSION Durable Object binding is not available');
  }
  const id = env.CREDENTIAL_SETUP_SESSION.idFromName(sessionId);
  return env.CREDENTIAL_SETUP_SESSION.get(id) as DurableObjectStub<CredentialSetupSession>;
}

export async function startSetupSession(
  env: Env,
  params: CreateSetupSessionParams
): Promise<SetupSessionStateResult> {
  return getStub(env, params.id).create(params);
}

export async function getSetupSessionState(
  env: Env,
  sessionId: string
): Promise<SetupSessionStateResult | null> {
  return getStub(env, sessionId).getState();
}

export async function cancelSetupSession(
  env: Env,
  sessionId: string
): Promise<SetupSessionStateResult> {
  return getStub(env, sessionId).cancel();
}
