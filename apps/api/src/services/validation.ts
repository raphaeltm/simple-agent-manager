import type { AgentType, CredentialKind } from '@simple-agent-manager/shared';

const ANTHROPIC_API_KEY_PREFIX = 'sk-ant-api';
const CLAUDE_OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * Result from OpenAI Codex auth.json validation, including optional metadata
 * extracted from the id_token JWT.
 */
export interface OpenAIAuthJsonValidation {
  valid: boolean;
  error?: string;
  metadata?: {
    planType?: string;
    isExpired?: boolean;
  };
}

/**
 * Decode a JWT payload without signature verification.
 * Returns the parsed claims object or null on failure.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // Base64url → Base64 → decode
    const payload = parts[1]!;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Validate OpenAI Codex auth.json structure.
 * The credential must be a JSON blob with the structure written by `codex login`.
 */
export function validateOpenAICodexAuthJson(credential: string): OpenAIAuthJsonValidation {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return { valid: false, error: 'Invalid JSON. Paste the full contents of ~/.codex/auth.json' };
  }

  // Verify auth_mode
  const authMode = parsed.auth_mode;
  if (typeof authMode !== 'string' || (authMode !== 'Chatgpt' && authMode !== 'chatgpt')) {
    return { valid: false, error: 'Invalid auth_mode. Expected "Chatgpt". This may not be a valid auth.json file.' };
  }

  // Verify tokens object
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== 'object') {
    return { valid: false, error: 'Missing "tokens" object. Paste the full contents of ~/.codex/auth.json' };
  }

  const accessToken = tokens.access_token;
  if (typeof accessToken !== 'string' || !accessToken.startsWith('eyJ')) {
    return { valid: false, error: 'Missing or invalid access_token. Must be a JWT (starts with eyJ).' };
  }

  const refreshToken = tokens.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken.startsWith('rt_')) {
    return { valid: false, error: 'Missing or invalid refresh_token. Must start with "rt_".' };
  }

  const idToken = tokens.id_token;
  if (typeof idToken !== 'string' || !idToken.startsWith('eyJ')) {
    return { valid: false, error: 'Missing or invalid id_token. Must be a JWT (starts with eyJ).' };
  }

  // Decode JWTs to verify they are structurally valid (not just prefix checks)
  const accessClaims = decodeJwtPayload(accessToken);
  if (!accessClaims) {
    return { valid: false, error: 'access_token is not a valid JWT. Could not decode payload.' };
  }
  if (typeof accessClaims.exp !== 'number') {
    return { valid: false, error: 'access_token JWT is missing a numeric "exp" claim.' };
  }

  const idClaims = decodeJwtPayload(idToken);
  if (!idClaims) {
    return { valid: false, error: 'id_token is not a valid JWT. Could not decode payload.' };
  }

  // Extract metadata from id_token for display
  const authNamespace = idClaims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const planType = authNamespace?.chatgpt_plan_type as string | undefined;

  // Check access_token expiry
  const isExpired = (accessClaims.exp * 1000) < Date.now();

  return {
    valid: true,
    metadata: { planType, isExpired },
  };
}

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
   * Validate credential format for a specific kind and agent type.
   * @param credential The credential to validate
   * @param kind The expected credential kind
   * @param agentType Optional agent type for agent-specific validation
   * @returns Validation result with error message if invalid
   */
  static validateCredential(
    credential: string,
    kind: CredentialKind,
    agentType?: AgentType
  ): { valid: boolean; error?: string } {
    if (!credential || credential.trim().length === 0) {
      return { valid: false, error: 'Credential cannot be empty' };
    }

    // Agent-specific validation for OpenAI Codex OAuth tokens (auth.json blobs)
    if (agentType === 'openai-codex' && kind === 'oauth-token') {
      const result = validateOpenAICodexAuthJson(credential);
      return { valid: result.valid, error: result.error };
    }

    if (kind === 'api-key') {
      // Only apply Anthropic prefix check for claude-code agent
      if (agentType === 'claude-code' || !agentType) {
        if (credential.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
          return {
            valid: false,
            error: 'This looks like a Claude OAuth token. Please use the "OAuth Token (Pro/Max)" option instead.',
          };
        }

        if (!agentType && credential.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
          // Legacy behavior: accept without agent context
          if (credential.length < 20) {
            return { valid: false, error: 'API key appears too short' };
          }
          return { valid: true };
        }

        if (agentType === 'claude-code') {
          if (!credential.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
            return {
              valid: false,
              error: 'API key should start with "sk-ant-api"',
            };
          }
          if (credential.length < 20) {
            return { valid: false, error: 'API key appears too short' };
          }
        }
      }
      // For non-Anthropic agents with API keys, accept any non-empty value
    } else if (kind === 'oauth-token') {
      // Claude OAuth tokens: reject obvious API keys
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
   * @param agentType Optional agent type for agent-specific messages
   * @returns User-friendly error message
   */
  static getCredentialErrorMessage(kind: CredentialKind, error: string, agentType?: AgentType): string {
    if (kind === 'oauth-token') {
      if (agentType === 'openai-codex') {
        if (error.includes('401') || error.includes('unauthorized')) {
          return 'OpenAI OAuth token is invalid or expired. Run "codex login" to refresh your auth.json.';
        }
        if (error.includes('403') || error.includes('forbidden')) {
          return 'OpenAI OAuth token does not have required permissions. Ensure your ChatGPT subscription is active.';
        }
      }
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
