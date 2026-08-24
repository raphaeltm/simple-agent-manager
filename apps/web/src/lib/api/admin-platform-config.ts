import { request } from './client';

export type PlatformConfigSource = 'runtime' | 'environment' | 'unset';

export interface PlatformConfigFieldStatus {
  configured: boolean;
  source: PlatformConfigSource;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface PlatformIntegrationStatus {
  configured: boolean;
  source: PlatformConfigSource;
  label: string;
  fields: Record<string, PlatformConfigFieldStatus>;
}

export type FeedbackProjectState = 'unset' | 'ready' | 'missing' | 'inaccessible';

export interface FeedbackProjectStatus {
  configured: boolean;
  source: PlatformConfigSource;
  label: string;
  state: FeedbackProjectState;
  projectId: string | null;
  project: {
    id: string;
    name: string;
    status: string | null;
  } | null;
  message: string;
  fields: Record<string, PlatformConfigFieldStatus>;
}

export interface PlatformConfigStatus {
  setupCompleted: boolean;
  setupForced: boolean;
  integrations: {
    githubOAuth: PlatformIntegrationStatus;
    githubApp: PlatformIntegrationStatus;
    githubWebhook: PlatformIntegrationStatus;
    googleOAuth: PlatformIntegrationStatus;
    googleInfrastructureOAuth: PlatformIntegrationStatus;
    gitlabOAuth: PlatformIntegrationStatus;
  };
  feedbackProject: FeedbackProjectStatus;
}

export interface PlatformIntegrationConfigInput {
  github?: {
    clientId?: string;
    clientSecret?: string;
    appId?: string;
    appPrivateKey?: string;
    appSlug?: string;
    webhookSecret?: string;
  };
  google?: {
    clientId?: string;
    clientSecret?: string;
  };
  googleInfrastructure?: {
    clientId?: string;
    clientSecret?: string;
    remove?: boolean;
  };
  gitlab?: {
    host?: string;
    clientId?: string;
    clientSecret?: string;
  };
  feedback?: {
    projectId?: string;
    remove?: boolean;
  };
}

export interface PlatformConfigStatusResponse {
  status: PlatformConfigStatus;
}

export async function fetchAdminPlatformConfig(): Promise<PlatformConfigStatusResponse> {
  return request<PlatformConfigStatusResponse>('/api/admin/platform-config');
}

export async function updateAdminPlatformConfig(
  config: PlatformIntegrationConfigInput
): Promise<PlatformConfigStatusResponse> {
  return request<PlatformConfigStatusResponse>('/api/admin/platform-config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
}
