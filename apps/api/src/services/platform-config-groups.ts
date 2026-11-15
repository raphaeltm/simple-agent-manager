import { SECRET_KINDS, SETTING_KEYS, trimOptional } from './platform-config-store';
import type { PlatformIntegrationGroup, PlatformIntegrationInput } from './platform-config-types';

/*
 * One map of what each Admin → Integrations group stores, shared by the clear path, its audit,
 * validation and the owner alert wording. A group lists every `platform_settings` key and
 * `platform_credentials` row it owns, each with the audit name it is recorded under.
 */

export type IntegrationAuditName = `integration.${string}`;

interface StoredSetting {
  key: string;
  auditName: IntegrationAuditName;
}

interface StoredCredential {
  provider: string;
  kind: string;
  auditName: IntegrationAuditName;
}

interface IntegrationGroupStorage {
  settings: StoredSetting[];
  credentials: StoredCredential[];
  /** The input fields that would set this group, as `[provider, field]` pairs. */
  inputFields: Array<[keyof Omit<PlatformIntegrationInput, 'clear' | 'feedback'>, string]>;
}

export const INTEGRATION_GROUP_TITLES: Record<PlatformIntegrationGroup, string> = {
  githubOAuth: 'GitHub OAuth',
  githubApp: 'GitHub App',
  githubWebhook: 'GitHub webhooks',
  googleOAuth: 'Google sign-in (OAuth)',
  googleInfrastructureOAuth: 'Google infrastructure OAuth',
  gitlabOAuth: 'GitLab OAuth',
};

export const INTEGRATION_GROUP_STORAGE: Record<PlatformIntegrationGroup, IntegrationGroupStorage> =
  {
    githubOAuth: {
      settings: [{ key: SETTING_KEYS.githubClientId, auditName: SETTING_KEYS.githubClientId }],
      credentials: [
        {
          provider: 'github',
          kind: SECRET_KINDS.githubClientSecret,
          auditName: 'integration.github.clientSecret',
        },
      ],
      inputFields: [
        ['github', 'clientId'],
        ['github', 'clientSecret'],
      ],
    },
    githubApp: {
      settings: [
        { key: SETTING_KEYS.githubAppId, auditName: SETTING_KEYS.githubAppId },
        { key: SETTING_KEYS.githubAppSlug, auditName: SETTING_KEYS.githubAppSlug },
      ],
      credentials: [
        {
          provider: 'github',
          kind: SECRET_KINDS.githubAppPrivateKey,
          auditName: 'integration.github.appPrivateKey',
        },
      ],
      inputFields: [
        ['github', 'appId'],
        ['github', 'appSlug'],
        ['github', 'appPrivateKey'],
      ],
    },
    githubWebhook: {
      settings: [],
      credentials: [
        {
          provider: 'github',
          kind: SECRET_KINDS.githubWebhookSecret,
          auditName: 'integration.github.webhookSecret',
        },
      ],
      inputFields: [['github', 'webhookSecret']],
    },
    googleOAuth: {
      settings: [{ key: SETTING_KEYS.googleClientId, auditName: SETTING_KEYS.googleClientId }],
      credentials: [
        {
          provider: 'google',
          kind: SECRET_KINDS.googleClientSecret,
          auditName: 'integration.google.clientSecret',
        },
      ],
      inputFields: [
        ['google', 'clientId'],
        ['google', 'clientSecret'],
      ],
    },
    googleInfrastructureOAuth: {
      settings: [
        {
          key: SETTING_KEYS.googleInfrastructureClientId,
          auditName: SETTING_KEYS.googleInfrastructureClientId,
        },
      ],
      credentials: [
        {
          provider: 'google-infrastructure',
          kind: SECRET_KINDS.googleInfrastructureClientSecret,
          auditName: 'integration.googleInfrastructure.clientSecret',
        },
      ],
      inputFields: [
        ['googleInfrastructure', 'clientId'],
        ['googleInfrastructure', 'clientSecret'],
      ],
    },
    gitlabOAuth: {
      settings: [
        { key: SETTING_KEYS.gitlabHost, auditName: SETTING_KEYS.gitlabHost },
        { key: SETTING_KEYS.gitlabClientId, auditName: SETTING_KEYS.gitlabClientId },
      ],
      credentials: [
        {
          provider: 'gitlab',
          kind: SECRET_KINDS.gitlabClientSecret,
          auditName: 'integration.gitlab.clientSecret',
        },
      ],
      inputFields: [
        ['gitlab', 'host'],
        ['gitlab', 'clientId'],
        ['gitlab', 'clientSecret'],
      ],
    },
  };

/** True when the input carries a non-blank value for any field of the group. */
export function integrationGroupHasValues(
  input: PlatformIntegrationInput,
  group: PlatformIntegrationGroup
): boolean {
  return INTEGRATION_GROUP_STORAGE[group].inputFields.some(([provider, field]) =>
    Boolean(
      trimOptional((input[provider] as Record<string, string | undefined> | undefined)?.[field])
    )
  );
}

/** Audit names for every field the input sets, across all groups (OAuth, App and webhook). */
export function integrationSetAuditNames(input: PlatformIntegrationInput): IntegrationAuditName[] {
  const names: IntegrationAuditName[] = [];
  for (const storage of Object.values(INTEGRATION_GROUP_STORAGE)) {
    for (const [provider, field] of storage.inputFields) {
      const value = (input[provider] as Record<string, string | undefined> | undefined)?.[field];
      if (trimOptional(value)) names.push(`integration.${provider}.${field}`);
    }
  }
  return names;
}

/** Title of the group an audit name belongs to, for alert wording. */
export function integrationGroupTitleForName(name: string): string | null {
  for (const [group, storage] of Object.entries(INTEGRATION_GROUP_STORAGE)) {
    if (
      storage.settings.some((item) => item.auditName === name) ||
      storage.credentials.some((item) => item.auditName === name)
    ) {
      return INTEGRATION_GROUP_TITLES[group as PlatformIntegrationGroup];
    }
  }
  return null;
}
