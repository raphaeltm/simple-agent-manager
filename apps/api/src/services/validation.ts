import type { CredentialKind } from '@simple-agent-manager/shared';

const ANTHROPIC_API_KEY_PREFIX = 'sk-ant-api';
const CLAUDE_OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * Validate and detect credential format
 */
export class CredentialValidator {
  /**
   * Detect credential type based on format
   * @param credential The credential string to validate
   * @returns The detected credential kind or null if uncertain
   */
  static detectCredentialKind(credential: string): CredentialKind | null {
    if (credential.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
      return 'api-key';
    }

    if (credential.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
      return 'oauth-token';
    }

    // Other credential formats are intentionally treated as opaque.
    return null;
  }

  /**
   * Validate credential format for a specific kind
   * @param credential The credential to validate
   * @param kind The expected credential kind
   * @returns Validation result with error message if invalid
   */
  static validateCredential(
    credential: string,
    kind: CredentialKind
  ): { valid: boolean; error?: string } {
    if (!credential || credential.trim().length === 0) {
      return { valid: false, error: 'Credential cannot be empty' };
    }

    if (kind === 'api-key') {
      // Validate API key format
      if (credential.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
        return {
          valid: false,
          error: 'This looks like a Claude OAuth token. Please use the "OAuth Token (Pro/Max)" option instead.',
        };
      }

      if (!credential.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
        return {
          valid: false,
          error: 'API key should start with "sk-ant-api"',
        };
      }
      if (credential.length < 20) {
        return {
          valid: false,
          error: 'API key appears too short',
        };
      }
    } else if (kind === 'oauth-token') {
      // OAuth tokens are treated as opaque values.
      // We only reject obvious API keys to reduce user mistakes.
      if (credential.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
        return {
          valid: false,
          error: 'This looks like an API key, not an OAuth token. Please use the "API Key" option instead.',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Get a user-friendly error message for credential issues
   * @param kind The credential kind that failed
   * @param error The original error
   * @returns User-friendly error message
   */
  static getCredentialErrorMessage(kind: CredentialKind, error: string): string {
    if (kind === 'oauth-token') {
      if (error.includes('401') || error.includes('unauthorized')) {
        return 'OAuth token is invalid or expired. Please generate a new token using "claude setup-token" in your terminal.';
      }
      if (error.includes('403') || error.includes('forbidden')) {
        return 'OAuth token does not have required permissions. Please ensure your Claude subscription is active.';
      }
    } else if (kind === 'api-key') {
      if (error.includes('401') || error.includes('unauthorized')) {
        return 'API key is invalid. Please check your key in the Anthropic console.';
      }
      if (error.includes('429') || error.includes('rate limit')) {
        return 'API key has exceeded rate limits. Please try again later.';
      }
    }

    // Generic error
    return `Authentication failed: ${error}`;
  }
}
