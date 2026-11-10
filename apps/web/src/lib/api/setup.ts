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
  /** False while Cloudflare is still verifying the sending domain. */
  emailReady: boolean;
  /** The installer's administrator email, when the install was made by the installer. */
  ownerEmail: string | null;
}

export interface SetupVerifyResponse {
  ok: true;
  status: PlatformConfigStatus;
  signIn: SetupSignInSummary;
}

export interface SetupCompleteResponse {
  completed: true;
  status: PlatformConfigStatus;
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
  config: PlatformIntegrationConfigInput
): Promise<SetupCompleteResponse> {
  return request<SetupCompleteResponse>('/api/setup/complete', {
    method: 'POST',
    body: JSON.stringify({ token, config }),
  });
}
