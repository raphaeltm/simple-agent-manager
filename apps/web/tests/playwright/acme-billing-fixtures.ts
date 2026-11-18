/**
 * The fictional "Acme Billing" project and its owner, shared by the audits whose scenes also
 * produce documentation images (Project Overview, Insights), so the docs show one consistent,
 * made-up person and project.
 */
import { makeMockUser } from './audit-helpers';

/** The signed-in owner of the Acme Billing project. */
export function acmeBillingUser(userId: string, sessionId: string) {
  return makeMockUser({ email: 'dana@example.com', name: 'Dana Reyes', sessionId, userId });
}

/** The Acme Billing project (`acme/billing` on GitHub), owned by `userId`. */
export function acmeBillingProject(projectId: string, userId: string) {
  return {
    id: projectId,
    name: 'Acme Billing',
    repository: 'acme/billing',
    repoProvider: 'github',
    defaultBranch: 'main',
    userId,
    installationId: 'inst-1',
    defaultWorkspaceProfile: 'full',
    defaultDevcontainerConfigName: '',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    multiplayerActive: false,
    summary: {
      activeWorkspaceCount: 0,
      activeSessionCount: 0,
      lastActivityAt: null,
      taskCountsByStatus: {},
      linkedWorkspaces: 0,
    },
  };
}
