/**
 * Shared mocks for pages that open the profile editor or a project's settings in the
 * account specs (`profile-account-pins-audit.spec.ts`, `docs-screenshots-accounts.spec.ts`):
 * a profile row and the tail of the route handler both specs end with.
 */
import { type AuditResponder, makeMockProject, respondToAppShellRoute } from './audit-helpers';

/** An agent profile row as `GET /api/projects/:id/agent-profiles` returns it. */
export function makeAgentProfile(
  id: string,
  name: string,
  projectId: string | null,
  userId: string
) {
  return {
    id,
    projectId,
    userId,
    name,
    description: null,
    agentType: 'claude-code',
    model: null,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

interface ProfilePageRoutes {
  user: { user: { id: string } };
  projects: Array<{ id: string; name: string }>;
  profiles: ReturnType<typeof makeAgentProfile>[];
}

/**
 * Profiles, the profile editor's runtime reads, the new-chat picker, projects and the app
 * shell. Call it last in a handler, after the spec's own routes.
 */
export function respondToProfilePageRoute(
  path: string,
  respond: AuditResponder,
  { user, projects, profiles }: ProfilePageRoutes
): Promise<void> | undefined {
  if (/^\/api\/projects\/[^/]+\/agent-profiles$/.test(path)) {
    return respond(200, { items: profiles });
  }
  if (/\/agent-profiles\/[^/]+\/runtime\/env-vars$/.test(path)) {
    return respond(200, { envVars: [] });
  }
  if (/\/agent-profiles\/[^/]+\/runtime\/files$/.test(path)) return respond(200, { files: [] });
  if (/^\/api\/projects\/[^/]+\/agent-profiles\/picker$/.test(path)) {
    return respond(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
  }
  if (path === '/api/projects') return respond(200, { projects });
  const project = path.match(/^\/api\/projects\/([^/]+)$/);
  if (project) {
    const found = projects.find((each) => each.id === project[1]);
    return respond(200, makeMockProject({ ...found, userId: user.user.id }));
  }
  return respondToAppShellRoute(path, respond, { user, projects });
}
