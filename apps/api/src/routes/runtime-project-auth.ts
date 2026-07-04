import {
  type ProjectCapability,
  requireProjectAccess,
  requireProjectCapability,
} from '../middleware/project-auth';

type ProjectAuthDb = Parameters<typeof requireProjectAccess>[0];

export async function requireProjectRuntimeAuthorization(
  db: ProjectAuthDb,
  projectId: string,
  userId: string,
  capability: ProjectCapability
) {
  if (capability === 'project:read') {
    await requireProjectAccess(db, projectId, userId);
    return;
  }

  await requireProjectCapability(db, projectId, userId, capability);
}
