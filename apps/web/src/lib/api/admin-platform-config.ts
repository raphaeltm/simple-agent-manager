import { request } from './client';

/** `runtime` = stored in this installation's database; `environment` = Worker env fallback. */
export type PlatformConfigSource = 'runtime' | 'environment' | 'legacy-kv' | 'unset';

export interface PlatformConfigFieldStatus {
  configured: boolean;
  source: PlatformConfigSource;
  /** Server-provided source wording, e.g. "stored in SAM". */
  label: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
  /** Who last wrote a stored value, e.g. "first-run setup (unauthenticated)". */
  updatedByLabel?: string | null;
}

export interface PlatformIntegrationStatus {
  configured: boolean;
  source: PlatformConfigSource;
  label: string;
  /** True when at least one value is stored in SAM, so Clear would change something. */
  clearable?: boolean;
  fields: Record<string, PlatformConfigFieldStatus>;
}

export type PlatformIntegrationGroup = keyof PlatformConfigStatus['integrations'];

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
  /** Delete the stored values of these integration groups. */
  clear?: PlatformIntegrationGroup[];
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
