// =============================================================================
// Shared utility types used across multiple domains
// =============================================================================

export type VMSize = 'small' | 'medium' | 'large';

/**
 * VM location identifier. Widened to string to support all providers:
 * - Hetzner: 'fsn1', 'nbg1', 'hel1', 'ash', 'hil'
 * - Scaleway: 'fr-par-1', 'nl-ams-1', 'pl-waw-1', etc.
 */
export type VMLocation = string;

/**
 * Workspace provisioning profile.
 * - 'full': Standard devcontainer build (project's .devcontainer config)
 * - 'lightweight': Skip devcontainer build, use minimal base image with git clone.
 *   Much faster startup (~20s vs ~2min) but no project-specific tooling.
 */
export type WorkspaceProfile = 'full' | 'lightweight';

// =============================================================================
// API Error
// =============================================================================
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
