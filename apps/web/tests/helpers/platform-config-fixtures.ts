import type {
  FeedbackProjectStatus,
  PlatformConfigStatus,
  PlatformIntegrationStatus,
} from '../../src/lib/api';

export function integration(
  fields: string[],
  overrides: Partial<PlatformIntegrationStatus> = {}
): PlatformIntegrationStatus {
  return {
    configured: false,
    source: 'unset',
    label: 'not configured',
    fields: Object.fromEntries(
      fields.map((field) => [
        field,
        { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      ])
    ),
    ...overrides,
  };
}

export function makeStatus(
  infrastructure: PlatformIntegrationStatus = integration(['clientId', 'clientSecret']),
  feedbackProject: FeedbackProjectStatus = {
    configured: false,
    source: 'unset',
    label: 'not configured',
    state: 'unset',
    projectId: null,
    project: null,
    message: 'No feedback project is configured.',
    fields: {
      projectId: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
    },
  }
): PlatformConfigStatus {
  return {
    setupCompleted: true,
    setupForced: false,
    integrations: {
      githubOAuth: integration(['clientId', 'clientSecret']),
      githubApp: integration(['appId', 'appPrivateKey', 'appSlug']),
      githubWebhook: integration(['webhookSecret']),
      googleOAuth: integration(['clientId', 'clientSecret']),
      googleInfrastructureOAuth: infrastructure,
      gitlabOAuth: integration(['host', 'clientId', 'clientSecret']),
    },
    feedbackProject,
  };
}
