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

export async function fetchAdminPlatformConfig(
  signal?: AbortSignal
): Promise<PlatformConfigStatusResponse> {
  return request<PlatformConfigStatusResponse>('/api/admin/platform-config', { signal });
}

export async function updateAdminPlatformConfig(
  config: PlatformIntegrationConfigInput
): Promise<PlatformConfigStatusResponse> {
  return request<PlatformConfigStatusResponse>('/api/admin/platform-config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
}

export interface GitHubAppManifestStart {
  /** GitHub's "new App from manifest" URL, with the state SAM checks on return. */
  postUrl: string;
  manifest: Record<string, unknown>;
  state: string;
}

export async function startGitHubAppManifest(input: {
  name?: string;
  organization?: string;
}): Promise<GitHubAppManifestStart> {
  return request<GitHubAppManifestStart>('/api/admin/platform-config/github-app/manifest', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface GitHubAppManifestComplete extends PlatformConfigStatusResponse {
  app: { slug: string; htmlUrl: string | null; owner: string | null; installUrl: string };
}

export async function completeGitHubAppManifest(
  code: string,
  state: string
): Promise<GitHubAppManifestComplete> {
  return request<GitHubAppManifestComplete>(
    '/api/admin/platform-config/github-app/manifest/complete',
    { method: 'POST', body: JSON.stringify({ code, state }) }
  );
}
