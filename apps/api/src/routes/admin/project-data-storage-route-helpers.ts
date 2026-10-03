import { errors } from '../../middleware/error';

export function assertProjectId(projectId: string | undefined): string {
  if (!projectId?.trim()) throw errors.badRequest('projectId is required');
  return projectId.trim();
}
