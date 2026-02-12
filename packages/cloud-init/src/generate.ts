import { CLOUD_INIT_TEMPLATE } from './template';

/**
 * Variables for cloud-init generation.
 */
export interface CloudInitVariables {
  nodeId: string;
  hostname: string;
  controlPlaneUrl: string;
  jwksUrl: string;
  callbackToken: string;
}

/**
 * Generate cloud-init configuration from template with variables.
 */
export function generateCloudInit(variables: CloudInitVariables): string {
  let config = CLOUD_INIT_TEMPLATE;

  const replacements: Record<string, string> = {
    '{{ node_id }}': variables.nodeId,
    '{{ hostname }}': variables.hostname,
    '{{ control_plane_url }}': variables.controlPlaneUrl,
    '{{ jwks_url }}': variables.jwksUrl,
    '{{ callback_token }}': variables.callbackToken,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    config = config.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
  }

  return config;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate cloud-init config doesn't exceed Hetzner 32KB user-data limit.
 */
export function validateCloudInitSize(config: string): boolean {
  const sizeBytes = new TextEncoder().encode(config).length;
  const maxBytes = 32 * 1024;
  return sizeBytes <= maxBytes;
}
