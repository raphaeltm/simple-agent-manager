import type { Env } from '../env';
import { isSetupCompleted, resolvePlatformConfig } from './platform-config-core';
import type {
  IntegrationStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  ResolvedPlatformValue,
} from './platform-config-types';

/* Read-only projection of the resolved config into the setup-wizard status payload. */

function sourceLabel(source: PlatformConfigSource): string {
  if (source === 'runtime') return 'set here';
  if (source === 'environment') return 'set via environment fallback';
  return 'not configured';
}

function fieldStatus(
  value: ResolvedPlatformValue
): Omit<ResolvedPlatformValue, 'value'> & { configured: boolean } {
  return {
    configured: Boolean(value.value),
    source: value.source,
    updatedAt: value.updatedAt ?? null,
    updatedBy: value.updatedBy ?? null,
  };
}

function integrationStatus(
  fields: Record<string, ResolvedPlatformValue>,
  required: string[]
): IntegrationStatus {
  const configured = required.every((key) => Boolean(fields[key]?.value));
  const sources = required.map((key) => fields[key]?.source ?? 'unset');
  const source: PlatformConfigSource = sources.includes('runtime')
    ? 'runtime'
    : sources.includes('environment')
      ? 'environment'
      : 'unset';
  return {
    configured,
    source,
    label: sourceLabel(source),
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, fieldStatus(value)])
    ),
  };
}

export async function getPlatformConfigStatus(env: Env): Promise<PlatformConfigStatus> {
  const config = await resolvePlatformConfig(env);
  return {
    setupCompleted: await isSetupCompleted(env),
    setupForced: env.SETUP_FORCE === 'true',
    integrations: {
      githubOAuth: integrationStatus(
        { clientId: config.github.clientId, clientSecret: config.github.clientSecret },
        ['clientId', 'clientSecret']
      ),
      githubApp: integrationStatus(
        {
          appId: config.github.appId,
          appPrivateKey: config.github.appPrivateKey,
          appSlug: config.github.appSlug,
        },
        ['appId', 'appPrivateKey']
      ),
      githubWebhook: integrationStatus({ webhookSecret: config.github.webhookSecret }, [
        'webhookSecret',
      ]),
      googleOAuth: integrationStatus(
        { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
        ['clientId', 'clientSecret']
      ),
      googleInfrastructureOAuth: integrationStatus(
        {
          clientId: config.googleInfrastructure.clientId,
          clientSecret: config.googleInfrastructure.clientSecret,
        },
        ['clientId', 'clientSecret']
      ),
      gitlabOAuth: integrationStatus(
        {
          host: config.gitlab.host,
          clientId: config.gitlab.clientId,
          clientSecret: config.gitlab.clientSecret,
        },
        ['host', 'clientId', 'clientSecret']
      ),
    },
  };
}
