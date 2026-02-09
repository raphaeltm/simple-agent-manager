import type { CredentialKind } from '@simple-agent-manager/shared';

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
    // Anthropic API keys follow a specific pattern
    if (credential.startsWith('sk-ant-')) {
      return 'api-key';
    }

    // OAuth tokens are typically longer base64-like strings
    // They don't follow the API key format
    if (credential.length > 100 && !credential.startsWith('sk-')) {
      return 'oauth-token';
    }

    // Can't reliably detect - let user specify
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
      if (!credential.startsWith('sk-ant-')) {
        return {
          valid: false,
          error: 'API key should start with "sk-ant-"',
        };
      }
      if (credential.length < 20) {
        return {
          valid: false,
          error: 'API key appears too short',
        };
      }
    } else if (kind === 'oauth-token') {
      // OAuth tokens are more flexible, but should have minimum length
      if (credential.length < 50) {
        return {
          valid: false,
          error: 'OAuth token appears too short',
        };
      }
      // Warn if it looks like an API key
      if (credential.startsWith('sk-')) {
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