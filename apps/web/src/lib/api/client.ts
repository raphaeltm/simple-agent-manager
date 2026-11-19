import type { ApiError } from '@simple-agent-manager/shared';

export const GITHUB_REAUTH_REQUIRED_EVENT = 'sam:github-reauth-required';

// In production, VITE_API_URL must be explicitly set
export const API_URL = (() => {
  const url = import.meta.env.VITE_API_URL;
  if (!url && import.meta.env.PROD) {
    throw new Error('VITE_API_URL is required in production builds');
  }
  return url || 'http://localhost:8787';
})();

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly rejectedBeforeEffects = false
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * `GITHUB_REAUTH_REQUIRED`: a GitHub link exists but its token is unusable (sign out and back in).
 * `GITHUB_NOT_CONNECTED`: the account has no GitHub link at all (connect it in Settings).
 */
export type GitHubAccessProblem = 'GITHUB_REAUTH_REQUIRED' | 'GITHUB_NOT_CONNECTED';

function notifyGitHubReauthRequired(message: string, code: GitHubAccessProblem) {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(GITHUB_REAUTH_REQUIRED_EVENT, {
      detail: { message, code },
    })
  );
}

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    credentials: 'include', // Include cookies for session auth
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle non-JSON responses
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    if (!response.ok) {
      throw new ApiClientError(
        'UNKNOWN_ERROR',
        `Server returned non-JSON error response (${response.status})`,
        response.status
      );
    }
    // 204 No Content or missing content-type with empty body is expected for void endpoints
    if (response.status === 204 || !contentType) {
      return {} as T;
    }
    throw new ApiClientError(
      'UNEXPECTED_CONTENT_TYPE',
      `Expected JSON response but received: ${contentType}`,
      response.status
    );
  }

  const data = await response.json();

  if (!response.ok) {
    const error = data as ApiError;
    if (error.error === 'GITHUB_REAUTH_REQUIRED' || error.error === 'GITHUB_NOT_CONNECTED') {
      notifyGitHubReauthRequired(error.message, error.error);
    }
    throw new ApiClientError(
      error.error,
      error.message,
      response.status,
      typeof data === 'object' && data !== null && data.rejectedBeforeEffects === true
    );
  }

  return data as T;
}
