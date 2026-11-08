import type { AgentEmailSetupPlan } from '@simple-agent-manager/shared';

import type { PlatformConfigStatus, PlatformIntegrationConfigInput } from './admin';
import { request } from './client';

export interface SetupStatusResponse {
  completed: boolean;
  open: boolean;
  forced: boolean;
  tokenConfigured: boolean;
}

export interface SetupSignInSummary {
  /** This deployment can email sign-in codes. */
  email: boolean;
  /** The installer's administrator email, when the install was made by the installer. */
  ownerEmail: string | null;
}

export interface SetupVerifyResponse {
  ok: true;
  status: PlatformConfigStatus;
  signIn: SetupSignInSummary;
  /** What turning agent email on would change; null when it could not be read. */
  agentEmail: AgentEmailSetupPlan | null;
}

export interface SetupCompleteResponse {
  completed: true;
  status: PlatformConfigStatus;
  /** Present when agent email was requested: the resulting plan, or why it did not turn on. */
  agentEmail: { plan: AgentEmailSetupPlan | null; error: string | null } | null;
}

export interface LoginProvidersResponse {
  github: boolean;
  google: boolean;
  gitlab: boolean;
  email: boolean;
}

/** Public: which login providers are configured (Google = the login client). */
export async function fetchLoginProviders(): Promise<LoginProvidersResponse> {
  return request<LoginProvidersResponse>('/api/config/login-providers');
}

export async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  return request<SetupStatusResponse>('/api/setup/status');
}

export async function verifySetupToken(token: string): Promise<SetupVerifyResponse> {
  return request<SetupVerifyResponse>('/api/setup/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function completeSetup(
  token: string,
  config: PlatformIntegrationConfigInput,
  agentEmail?: { consentToken: string | null }
): Promise<SetupCompleteResponse> {
  return request<SetupCompleteResponse>('/api/setup/complete', {
    method: 'POST',
    body: JSON.stringify({ token, config, ...(agentEmail ? { agentEmail } : {}) }),
  });
}
