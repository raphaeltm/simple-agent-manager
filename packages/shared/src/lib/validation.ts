import type { CreateWorkspaceRequest, VMSize } from '../types';

/**
 * Validation error with field-specific messages
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const VALID_SIZES: VMSize[] = ['small', 'medium', 'large'];

// Repository pattern - owner/repo format
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// Name pattern - alphanumeric with dashes and underscores
const NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;

/**
 * Validate a CreateWorkspaceRequest
 */
export function validateCreateWorkspaceRequest(
  request: Partial<CreateWorkspaceRequest>
): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate name
  if (!request.name) {
    errors.push({ field: 'name', message: 'Name is required' });
  } else if (request.name.length > 50) {
    errors.push({ field: 'name', message: 'Name must be 50 characters or less' });
  } else if (!NAME_PATTERN.test(request.name)) {
    errors.push({
      field: 'name',
      message: 'Name must contain only letters, numbers, dashes, and underscores',
    });
  }

  // Validate repository
  if (!request.repository) {
    errors.push({ field: 'repository', message: 'Repository is required' });
  } else if (!REPO_PATTERN.test(request.repository)) {
    errors.push({ field: 'repository', message: 'Repository must be in owner/repo format' });
  }

  // Validate installationId
  if (!request.installationId) {
    errors.push({ field: 'installationId', message: 'GitHub installation is required' });
  }

  // Validate vmSize (optional)
  if (request.vmSize !== undefined && !VALID_SIZES.includes(request.vmSize)) {
    errors.push({
      field: 'vmSize',
      message: `VM size must be one of: ${VALID_SIZES.join(', ')}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract repository name from full name (owner/repo)
 */
export function extractRepoName(repository: string): string {
  const parts = repository.split('/');
  return parts[parts.length - 1] || 'workspace';
}
