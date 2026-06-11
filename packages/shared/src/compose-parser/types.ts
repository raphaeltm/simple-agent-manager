/**
 * Compose Parser Types
 *
 * Types for the Compose-subset parser that converts spec-valid
 * Docker Compose YAML + x-sam-* extensions into the normalized
 * SAM deployment manifest.
 */

import type { DeploymentManifest, ManifestError } from '../deployment-manifest';

// =============================================================================
// Errors — reuses ManifestError shape for consistency
// =============================================================================

export type ComposeParseError = ManifestError;

// =============================================================================
// Unresolved image reference
// =============================================================================

/**
 * An image reference that may contain a tag instead of a digest.
 * The parser outputs these; the resolver converts them to digest-pinned images.
 */
export interface UnresolvedImage {
  registry: string;
  repository: string;
  /** Either a `sha256:...` digest or a tag like `latest`, `v1.2.3`, etc. */
  reference: string;
}

// =============================================================================
// Unresolved service (image not yet digest-pinned)
// =============================================================================

export interface UnresolvedService {
  image: UnresolvedImage;
  command?: string[];
  env: Record<string, string | { secret: string }>;
  volumes: Array<{ name: string; mountPath: string }>;
  resources?: { memoryLimitMb: number; cpuLimit: number };
  healthCheck?: { path: string; port: number; expectedStatus: number };
}

// =============================================================================
// Unresolved manifest (before tag→digest resolution)
// =============================================================================

export interface UnresolvedManifest {
  version: 1;
  services: Record<string, UnresolvedService>;
  volumes: Record<string, { sizeHintMb?: number }>;
  routes: Array<{ service: string; port: number; mode: 'public' | 'private' }>;
  hooks?: {
    preFlight?: {
      service: string;
      command: string[];
      timeoutSeconds: number;
    };
  };
}

// =============================================================================
// Image resolver interface (injectable)
// =============================================================================

/**
 * Async function that resolves a tag to a digest.
 * Provided by the API layer at submission time.
 */
export type ImageResolver = (
  registry: string,
  repository: string,
  tag: string,
) => Promise<string>;

// =============================================================================
// Parse result
// =============================================================================

export type ComposeParseResult =
  | { success: true; manifest: UnresolvedManifest }
  | { success: false; errors: ComposeParseError[] };

export type ComposeResolveResult =
  | { success: true; manifest: DeploymentManifest }
  | { success: false; errors: ComposeParseError[] };
