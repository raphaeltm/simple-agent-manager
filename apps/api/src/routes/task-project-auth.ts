import { requireProjectCapability } from '../middleware/project-auth';

type ProjectAuthDb = Parameters<typeof requireProjectCapability>[0];

export function requireProjectTaskRead(
  db: ProjectAuthDb,
  projectId: string,
  userId: string
) {
  return requireProjectCapability(db, projectId, userId, 'task:read');
}

export function requireProjectTaskWrite(
  db: ProjectAuthDb,
  projectId: string,
  userId: string
) {
  return requireProjectCapability(db, projectId, userId, 'task:write');
}
