/**
 * Where a resolved value came from:
 * - `runtime`: stored in this installation's D1 (`platform_settings` / `platform_credentials`)
 * - `environment`: a Worker environment variable or secret (the deploy-time fallback)
 * - `legacy-kv`: a value read from the legacy KV namespace
 * - `unset`: nothing configured
 */
export type PlatformConfigSource = 'runtime' | 'environment' | 'legacy-kv' | 'unset';

/** Integration groups an admin can clear as a unit. Keys match `PlatformConfigStatus.integrations`. */
export const PLATFORM_INTEGRATION_GROUPS = [
  'githubOAuth',
  'githubApp',
  'githubWebhook',
  'googleOAuth',
  'googleInfrastructureOAuth',
  'gitlabOAuth',
] as const;
export type PlatformIntegrationGroup = (typeof PLATFORM_INTEGRATION_GROUPS)[number];

export interface ResolvedPlatformValue {
  value: string | null;
  source: PlatformConfigSource;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface ResolvedPlatformConfig {
  github: {
    clientId: ResolvedPlatformValue;
    clientSecret: ResolvedPlatformValue;
    appId: ResolvedPlatformValue;
    appPrivateKey: ResolvedPlatformValue;
    appSlug: ResolvedPlatformValue;
    webhookSecret: ResolvedPlatformValue;
  };
  google: {
    clientId: ResolvedPlatformValue;
    clientSecret: ResolvedPlatformValue;
  };
  googleInfrastructure: {
    clientId: ResolvedPlatformValue;
    clientSecret: ResolvedPlatformValue;
  };
  gitlab: {
    host: ResolvedPlatformValue;
    clientId: ResolvedPlatformValue;
    clientSecret: ResolvedPlatformValue;
  };
  feedback: {
    projectId: ResolvedPlatformValue;
  };
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
    githubOAuth: IntegrationStatus;
    githubApp: IntegrationStatus;
    githubWebhook: IntegrationStatus;
    googleOAuth: IntegrationStatus;
    googleInfrastructureOAuth: IntegrationStatus;
    gitlabOAuth: IntegrationStatus;
  };
  feedbackProject: FeedbackProjectStatus;
}

export interface PlatformConfigFieldStatus extends Omit<ResolvedPlatformValue, 'value'> {
  configured: boolean;
  /** Human-readable source, e.g. "stored in SAM" or "Worker environment fallback". */
  label: string;
  /** Who last wrote a stored value, as a person would read it. Null when not stored. */
  updatedByLabel: string | null;
}

export interface IntegrationStatus {
  configured: boolean;
  source: PlatformConfigSource;
  label: string;
  /** True when at least one field is stored in D1, so clearing would change something. */
  clearable: boolean;
  fields: Record<string, PlatformConfigFieldStatus>;
}

export interface PlatformIntegrationInput {
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
  /** Integration groups whose stored values are deleted, so resolution falls back to env or unset. */
  clear?: PlatformIntegrationGroup[];
}
