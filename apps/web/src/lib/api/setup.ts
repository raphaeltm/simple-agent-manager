import type {
  PlatformConfigStatus,
  PlatformConfigStatusResponse,
  PlatformIntegrationConfigInput,
} from './admin';
import { request } from './client';

export interface SetupStatusResponse {
  completed: boolean;
  open: boolean;
  forced: boolean;
  tokenConfigured: boolean;
}

export interface SetupVerifyResponse {
  ok: true;
  status: PlatformConfigStatus;
}

export interface SetupCompleteResponse {
  completed: true;
  status: PlatformConfigStatus;
}

export interface LoginProvidersResponse {
  github: boolean;
  google: boolean;
  gitlab: boolean;
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

export async function saveSetupConfig(
  token: string,
  config: PlatformIntegrationConfigInput,
): Promise<PlatformConfigStatusResponse> {
  return request<PlatformConfigStatusResponse>('/api/setup/config', {
    method: 'PUT',
    body: JSON.stringify({ token, config }),
  });
}

export async function completeSetup(
  token: string,
  config: PlatformIntegrationConfigInput,
): Promise<SetupCompleteResponse> {
  return request<SetupCompleteResponse>('/api/setup/complete', {
    method: 'POST',
    body: JSON.stringify({ token, config }),
  });
}
