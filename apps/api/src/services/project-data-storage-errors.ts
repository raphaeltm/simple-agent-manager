import { AppError } from '../middleware/error';

export const PROJECT_DATA_STORAGE_FULL = 'PROJECT_DATA_STORAGE_FULL';

export class ProjectDataStorageFullError extends AppError {
  constructor(projectId: string, operation: string) {
    super(
      507,
      PROJECT_DATA_STORAGE_FULL,
      'ProjectData storage is full; writes are paused until an administrator runs storage recovery.',
      {
        projectId,
        operation,
      }
    );
    this.name = 'ProjectDataStorageFullError';
  }
}

export function toProjectDataStorageFullError(
  projectId: string,
  operation: string,
  cause: unknown
): ProjectDataStorageFullError {
  if (cause instanceof ProjectDataStorageFullError) return cause;
  return new ProjectDataStorageFullError(projectId, operation);
}
