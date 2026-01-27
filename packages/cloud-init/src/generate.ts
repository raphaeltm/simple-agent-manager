import { CLOUD_INIT_TEMPLATE } from './template';

export interface CloudInitVariables {
  workspaceId: string;
  hostname: string;
  repository: string;
  branch: string;
  githubToken: string;
  controlPlaneUrl: string;
  jwksUrl: string;
  callbackToken: string;
}

/**
 * Generate cloud-init configuration from template with variables.
 */
export function generateCloudInit(variables: CloudInitVariables): string {
  let config = CLOUD_INIT_TEMPLATE;

  // Replace all template variables
  const replacements: Record<string, string> = {
    '{{ workspace_id }}': variables.workspaceId,
    '{{ hostname }}': variables.hostname,
    '{{ repository }}': variables.repository,
    '{{ branch }}': variables.branch,
    '{{ github_token }}': variables.githubToken,
    '{{ control_plane_url }}': variables.controlPlaneUrl,
    '{{ jwks_url }}': variables.jwksUrl,
    '{{ callback_token }}': variables.callbackToken,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    config = config.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
  }

  return config;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate cloud-init config doesn't exceed size limit.
 * Hetzner limit is 32KB.
 */
export function validateCloudInitSize(config: string): boolean {
  const sizeBytes = new TextEncoder().encode(config).length;
  const maxBytes = 32 * 1024; // 32KB
  return sizeBytes <= maxBytes;
}
