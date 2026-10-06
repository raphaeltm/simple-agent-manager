/**
 * Deployment Manifest Validation
 *
 * Two-phase validation:
 * 1. Schema validation (shape, types, formats) via Zod
 * 2. Semantic validation (cross-references, dangerous field detection)
 *
 * Returns structured, agent-friendly errors with path + message.
 */

import type { ZodError } from 'zod';

import type { DeploymentManifest } from './schema';
import { DeploymentManifestSchema } from './schema';

// =============================================================================
// Error types
// =============================================================================

export interface ManifestError {
  path: string;
  message: string;
}

export type ManifestValidationResult =
  | { success: true; manifest: DeploymentManifest }
  | { success: false; errors: ManifestError[] };

// =============================================================================
// Dangerous Compose-ism detection
// =============================================================================

/**
 * Common Docker Compose fields that are explicitly banned.
 * We detect these before Zod's `.strict()` rejects them as unknown,
 * so agents get a clear explanation rather than a generic "unrecognized key".
 */
const DANGEROUS_FIELDS: Record<string, string> = {
  build: 'Images must be prebuilt and pushed to a registry. The "build" field is not allowed — use a digest-pinned image instead.',
  privileged: 'Privileged containers are not allowed. Remove the "privileged" field.',
  network_mode: 'Custom network modes (e.g., host networking) are not allowed. All services share one private network.',
  ports: 'Host port publishing is not allowed. Use the "routes" array to expose services.',
  devices: 'Device access is not allowed. Remove the "devices" field.',
  cap_add: 'Adding Linux capabilities is not allowed. Remove the "cap_add" field.',
  cap_drop: 'Capability management is not allowed in the manifest. Remove the "cap_drop" field.',
  security_opt: 'Security options are not allowed. Remove the "security_opt" field.',
  sysctls: 'Kernel parameter tuning is not allowed. Remove the "sysctls" field.',
  ulimits: 'ulimits configuration is not allowed. Remove the "ulimits" field.',
  pid: 'PID namespace sharing is not allowed. Remove the "pid" field.',
  ipc: 'IPC namespace sharing is not allowed. Remove the "ipc" field.',
  extends: 'The "extends" field is not supported. Define each service inline.',
  env_file: 'The "env_file" field is not allowed. Use "env" with plain values or { "secret": "name" } references.',
  runtime: 'Custom container runtimes are not allowed. Remove the "runtime" field.',
};

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a deployment manifest from raw (unknown) input.
 *
 * Phase 1: Detect dangerous Compose-isms with friendly messages.
 * Phase 2: Zod schema validation (shape, types, formats, strict).
 * Phase 3: Semantic cross-reference validation.
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: ManifestError[] = [];

  // Phase 1: Detect dangerous fields before Zod strips context
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    detectDangerousFields(input as Record<string, unknown>, errors);
  }

  // If we found dangerous top-level or service-level fields, return early
  // with those friendly messages rather than mixing in Zod's generic errors.
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Phase 2: Zod schema validation
  const result = DeploymentManifestSchema.safeParse(input);

  if (!result.success) {
    return { success: false, errors: formatZodErrors(result.error) };
  }

  const manifest = result.data;

  // Phase 3: Semantic cross-reference validation
  validateCrossReferences(manifest, errors);

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, manifest };
}

// =============================================================================
// Phase 1: Dangerous field detection
// =============================================================================

function detectDangerousFields(
  input: Record<string, unknown>,
  errors: ManifestError[],
): void {
  // Check top-level dangerous fields
  for (const [field, message] of Object.entries(DANGEROUS_FIELDS)) {
    if (field in input) {
      errors.push({ path: field, message });
    }
  }

  // Check service-level dangerous fields
  const services = input['services'];
  if (typeof services === 'object' && services !== null && !Array.isArray(services)) {
    for (const [serviceName, serviceConfig] of Object.entries(services as Record<string, unknown>)) {
      if (typeof serviceConfig !== 'object' || serviceConfig === null || Array.isArray(serviceConfig)) {
        continue;
      }
      for (const [field, message] of Object.entries(DANGEROUS_FIELDS)) {
        if (field in (serviceConfig as Record<string, unknown>)) {
          errors.push({ path: `services.${serviceName}.${field}`, message });
        }
      }
    }
  }
}

// =============================================================================
// Phase 2: Zod error formatting
// =============================================================================

function formatZodErrors(error: ZodError): ManifestError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

// =============================================================================
// Phase 3: Cross-reference validation
// =============================================================================

function validateCrossReferences(
  manifest: DeploymentManifest,
  errors: ManifestError[],
): void {
  const declaredServices = new Set(Object.keys(manifest.services));
  const declaredVolumes = new Set(Object.keys(manifest.volumes));

  // Validate route.service references
  for (const [i, route] of manifest.routes.entries()) {
    if (!declaredServices.has(route.service)) {
      errors.push({
        path: `routes[${i}].service`,
        message: `Route references service "${route.service}" which is not declared in "services". Declared services: ${[...declaredServices].join(', ')}`,
      });
    }
  }

  // Validate service volume name references
  for (const [serviceName, service] of Object.entries(manifest.services)) {
    for (const [i, vol] of service.volumes.entries()) {
      if (!declaredVolumes.has(vol.name)) {
        errors.push({
          path: `services.${serviceName}.volumes[${i}].name`,
          message: `Volume "${vol.name}" is not declared in "volumes". Declared volumes: ${[...declaredVolumes].join(', ') || '(none)'}`,
        });
      }
    }
  }

  // Validate hook service references
  if (manifest.hooks?.preFlight) {
    if (!declaredServices.has(manifest.hooks.preFlight.service)) {
      errors.push({
        path: 'hooks.preFlight.service',
        message: `Hook references service "${manifest.hooks.preFlight.service}" which is not declared in "services". Declared services: ${[...declaredServices].join(', ')}`,
      });
    }
  }
}
