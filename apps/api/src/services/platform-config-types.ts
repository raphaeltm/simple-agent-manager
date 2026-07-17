export type PlatformConfigSource = 'runtime' | 'environment' | 'unset';

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
}

export interface IntegrationStatus {
  configured: boolean;
  source: PlatformConfigSource;
  label: string;
  fields: Record<string, Omit<ResolvedPlatformValue, 'value'> & { configured: boolean }>;
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
    remove?: boolean;
  };
  gitlab?: {
    host?: string;
    clientId?: string;
    clientSecret?: string;
  };
}
