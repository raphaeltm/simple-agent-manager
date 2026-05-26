import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import { getExternalInstallationId } from '../../../services/github-installation-ids';
import type { AnthropicToolDef, ToolContext } from '../types';

export const getAccountSetupStatusDef: AnthropicToolDef = {
  name: 'get_account_setup_status',
  description:
    'Check the current user\'s account setup status: cloud credentials, GitHub App installation, and projects. Use this to guide new users through onboarding.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export async function getAccountSetupStatus(
  _input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });

  const [creds, installations, projects] = await Promise.all([
    db
      .select({
        provider: schema.credentials.provider,
        credentialType: schema.credentials.credentialType,
        agentType: schema.credentials.agentType,
        isActive: schema.credentials.isActive,
      })
      .from(schema.credentials)
      .where(eq(schema.credentials.userId, ctx.userId)),
    db
      .select({
        installationId: schema.githubInstallations.installationId,
        externalInstallationId: schema.githubInstallations.externalInstallationId,
        accountName: schema.githubInstallations.accountName,
        accountType: schema.githubInstallations.accountType,
      })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, ctx.userId)),
    db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        repository: schema.projects.repository,
        status: schema.projects.status,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.userId, ctx.userId),
          eq(schema.projects.status, 'active'),
        ),
      ),
  ]);

  const hasCloudProvider = creds.some(
    (c) => c.credentialType === 'cloud-provider' && c.isActive,
  );
  const hasAgentKey = creds.some(
    (c) => c.credentialType === 'agent-api-key' && c.isActive,
  );
  const hasGitHubApp = installations.length > 0;
  const hasProjects = projects.length > 0;

  const steps = {
    cloud_provider: {
      done: hasCloudProvider,
      label: 'Cloud provider credentials (Hetzner)',
    },
    agent_key: {
      done: hasAgentKey,
      label: 'AI agent API key (Claude or OpenAI)',
    },
    github_app: {
      done: hasGitHubApp,
      label: 'GitHub App installed',
    },
    project: {
      done: hasProjects,
      label: 'First project created',
    },
  };

  const completedCount = Object.values(steps).filter((s) => s.done).length;
  const totalSteps = Object.keys(steps).length;
  const isFullySetUp = completedCount === totalSteps;

  return {
    is_new_user: completedCount === 0,
    is_fully_set_up: isFullySetUp,
    completed: completedCount,
    total: totalSteps,
    steps,
    github_installations: installations.map((installation) => ({
      ...installation,
      installationId: getExternalInstallationId(installation),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, repository: p.repository })),
  };
}
