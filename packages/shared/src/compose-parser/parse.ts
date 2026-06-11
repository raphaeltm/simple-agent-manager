/**
 * Compose-Subset Parser
 *
 * Parses a spec-valid Docker Compose YAML document with x-sam-* extensions
 * into an UnresolvedManifest. The manifest contains unresolved image
 * references (tags allowed) that must be resolved to digests before
 * final validation.
 */

import { parse as parseYaml } from 'yaml';

import {
  DENIED_SERVICE_FIELDS,
  DENIED_TOP_LEVEL_FIELDS,
  SERVICE_ALLOWED,
  TOP_LEVEL_ALLOWED,
  TOP_LEVEL_IGNORED,
} from './constants';
import {
  parseEnvironment,
  parseHealthcheck,
  parseHooks,
  parseResources,
  parseRoutes,
  parseServiceVolumes,
  parseVolumes,
} from './parse-fields';
import type { ComposeParseError, ComposeParseResult, UnresolvedImage, UnresolvedManifest, UnresolvedService } from './types';

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Parse a Docker Compose YAML string into an UnresolvedManifest.
 *
 * The parser enforces a strict allowlist/denylist of Compose fields,
 * extracts x-sam-* extensions, and produces an intermediate result
 * with unresolved image references.
 */
export function parseCompose(yamlString: string): ComposeParseResult {
  const errors: ComposeParseError[] = [];

  // Parse YAML
  let doc: unknown;
  try {
    doc = parseYaml(yamlString);
  } catch (e) {
    return {
      success: false,
      errors: [{ path: '(root)', message: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      success: false,
      errors: [{ path: '(root)', message: 'Compose file must be a YAML mapping (object), not a scalar or sequence.' }],
    };
  }

  const root = doc as Record<string, unknown>;

  // Validate top-level fields
  validateTopLevelFields(root, errors);
  if (errors.length > 0) return { success: false, errors };

  // Extract services
  const rawServices = root['services'];
  if (typeof rawServices !== 'object' || rawServices === null || Array.isArray(rawServices)) {
    return {
      success: false,
      errors: [{ path: 'services', message: 'The "services" field must be a mapping of service names to service definitions.' }],
    };
  }

  const servicesMap = rawServices as Record<string, unknown>;
  if (Object.keys(servicesMap).length === 0) {
    return {
      success: false,
      errors: [{ path: 'services', message: 'At least one service must be defined.' }],
    };
  }

  // Parse services
  const services: Record<string, UnresolvedService> = {};
  for (const [name, config] of Object.entries(servicesMap)) {
    const service = parseService(name, config, errors);
    if (service) {
      services[name] = service;
    }
  }

  // Parse volumes
  const volumes = parseVolumes(root['volumes'], errors);

  // Parse routes from x-sam-routes + ports/expose hints
  const routes = parseRoutes(root['x-sam-routes'], servicesMap, errors);

  // Parse hooks from x-sam-pre-flight
  const hooks = parseHooks(root['x-sam-pre-flight'], errors);

  if (errors.length > 0) return { success: false, errors };

  // Cross-reference validation
  const declaredServices = new Set(Object.keys(services));
  const declaredVolumes = new Set(Object.keys(volumes));

  // Validate route service references
  for (const [i, route] of routes.entries()) {
    if (!declaredServices.has(route.service)) {
      errors.push({
        path: `x-sam-routes[${i}].service`,
        message: `Route references service "${route.service}" which is not defined in "services". Defined services: ${[...declaredServices].join(', ')}`,
      });
    }
  }

  // Validate volume references
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [i, vol] of service.volumes.entries()) {
      if (!declaredVolumes.has(vol.name)) {
        errors.push({
          path: `services.${serviceName}.volumes[${i}]`,
          message: `Volume "${vol.name}" is not declared in top-level "volumes". Declared volumes: ${[...declaredVolumes].join(', ') || '(none)'}`,
        });
      }
    }
  }

  // Validate hook references
  if (hooks?.preFlight && !declaredServices.has(hooks.preFlight.service)) {
    errors.push({
      path: 'x-sam-pre-flight.service',
      message: `Hook references service "${hooks.preFlight.service}" which is not defined in "services". Defined services: ${[...declaredServices].join(', ')}`,
    });
  }

  if (routes.length === 0) {
    errors.push({
      path: 'x-sam-routes',
      message: 'At least one route must be defined. Add an "x-sam-routes" entry to expose a service.',
    });
  }

  if (errors.length > 0) return { success: false, errors };

  const manifest: UnresolvedManifest = {
    version: 1,
    services,
    volumes,
    routes,
  };

  if (hooks) {
    manifest.hooks = hooks;
  }

  return { success: true, manifest };
}

// =============================================================================
// Top-level field validation
// =============================================================================

function validateTopLevelFields(root: Record<string, unknown>, errors: ComposeParseError[]): void {
  for (const key of Object.keys(root)) {
    // Skip known ignored fields
    if (TOP_LEVEL_IGNORED.has(key)) continue;

    // Allow x-sam-* extensions and known fields
    if (key.startsWith('x-sam-')) continue;
    if (TOP_LEVEL_ALLOWED.has(key)) continue;

    // Check denylist
    if (key in DENIED_TOP_LEVEL_FIELDS) {
      errors.push({ path: key, message: DENIED_TOP_LEVEL_FIELDS[key]! });
      continue;
    }

    // Unknown x- extension: warn but allow (Compose spec allows x-*)
    if (key.startsWith('x-')) continue;

    // Unknown field: reject
    errors.push({
      path: key,
      message: `Unknown top-level field "${key}" is not allowed. SAM accepts only: ${[...TOP_LEVEL_ALLOWED].join(', ')}.`,
    });
  }
}

// =============================================================================
// Service parsing
// =============================================================================

function parseService(
  name: string,
  config: unknown,
  errors: ComposeParseError[],
): UnresolvedService | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    errors.push({
      path: `services.${name}`,
      message: `Service "${name}" must be a mapping, not a scalar or sequence.`,
    });
    return null;
  }

  const svc = config as Record<string, unknown>;
  const prefix = `services.${name}`;

  // Check for denied fields first
  for (const [field, message] of Object.entries(DENIED_SERVICE_FIELDS)) {
    if (field in svc) {
      errors.push({ path: `${prefix}.${field}`, message });
    }
  }

  // Check for unknown fields (default-deny)
  for (const key of Object.keys(svc)) {
    if (key.startsWith('x-')) continue; // x-* extensions are Compose-spec-valid
    if (SERVICE_ALLOWED.has(key)) continue;
    if (key in DENIED_SERVICE_FIELDS) continue; // already reported above
    errors.push({
      path: `${prefix}.${key}`,
      message: `Unknown service field "${key}" is not allowed in the SAM Compose subset.`,
    });
  }

  // If denied fields found, stop processing this service
  if (errors.length > 0) return null;

  // Image (required)
  const image = parseImage(svc['image'], prefix, errors);
  if (!image) return null;

  // Command
  const command = parseStringOrArray(svc['command'], `${prefix}.command`, errors);

  // Entrypoint → treated as command override if present
  const entrypoint = parseStringOrArray(svc['entrypoint'], `${prefix}.entrypoint`, errors);

  // Environment
  const env = parseEnvironment(svc['environment'], prefix, errors);

  // Volumes
  const volumes = parseServiceVolumes(svc['volumes'], prefix, errors);

  // Resources from deploy.resources
  const resources = parseResources(svc['deploy'], prefix, errors);

  // Healthcheck
  const healthCheck = parseHealthcheck(svc['healthcheck'], prefix, errors);

  if (errors.length > 0) return null;

  const service: UnresolvedService = {
    image,
    env,
    volumes,
  };

  // Entrypoint takes precedence when both are set (Compose behavior)
  if (entrypoint) {
    service.command = entrypoint;
  } else if (command) {
    service.command = command;
  }

  if (resources) service.resources = resources;
  if (healthCheck) service.healthCheck = healthCheck;

  return service;
}

// =============================================================================
// Image parsing
// =============================================================================

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function parseImage(
  value: unknown,
  prefix: string,
  errors: ComposeParseError[],
): UnresolvedImage | null {
  if (value === undefined || value === null) {
    errors.push({
      path: `${prefix}.image`,
      message: 'Service must have an "image" field. Build-from-source is not supported.',
    });
    return null;
  }

  if (typeof value !== 'string') {
    errors.push({
      path: `${prefix}.image`,
      message: 'The "image" field must be a string (e.g., "ghcr.io/org/app:v1.0" or "ghcr.io/org/app@sha256:...").',
    });
    return null;
  }

  const raw = value.trim();
  if (raw.length === 0) {
    errors.push({
      path: `${prefix}.image`,
      message: 'The "image" field must not be empty.',
    });
    return null;
  }

  return parseImageReference(raw);
}

/**
 * Parse a Docker image reference string into registry, repository, and reference.
 *
 * Supports:
 * - `registry/repo:tag`
 * - `registry/repo@sha256:...`
 * - `repo:tag` (defaults to docker.io)
 * - `repo` (defaults to docker.io, tag=latest)
 */
function parseImageReference(ref: string): UnresolvedImage {
  let registry: string;
  let remainder: string;

  // Check if the first part looks like a registry (contains a dot or colon, or is localhost)
  const parts = ref.split('/');
  if (
    parts.length > 1 &&
    (parts[0]!.includes('.') || parts[0]!.includes(':') || parts[0] === 'localhost')
  ) {
    registry = parts[0]!;
    remainder = parts.slice(1).join('/');
  } else {
    registry = 'docker.io';
    remainder = ref;
    // Docker Hub convention: single name → library/name
    if (!remainder.includes('/')) {
      remainder = `library/${remainder}`;
    }
  }

  // Split by @sha256: (digest) or : (tag)
  let repository: string;
  let reference: string;

  if (remainder.includes('@sha256:')) {
    const idx = remainder.indexOf('@sha256:');
    repository = remainder.substring(0, idx);
    reference = remainder.substring(idx + 1); // sha256:...
  } else if (remainder.includes(':')) {
    const idx = remainder.lastIndexOf(':');
    repository = remainder.substring(0, idx);
    reference = remainder.substring(idx + 1);
  } else {
    repository = remainder;
    reference = 'latest';
  }

  return { registry, repository, reference };
}

/**
 * Returns true if the image reference is already a digest (sha256:...).
 */
export function isDigestReference(ref: string): boolean {
  return SHA256_DIGEST_RE.test(ref);
}

// =============================================================================
// Command/entrypoint parsing
// =============================================================================

function parseStringOrArray(
  value: unknown,
  path: string,
  errors: ComposeParseError[],
): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    // Shell-form command — split on whitespace (Compose behavior)
    return value.split(/\s+/).filter(Boolean);
  }

  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      if (typeof item !== 'string') {
        errors.push({
          path: `${path}[${i}]`,
          message: `Each element in "${path}" must be a string.`,
        });
      }
    }
    return value.filter((v) => typeof v === 'string') as string[];
  }

  errors.push({
    path,
    message: `"${path}" must be a string or an array of strings.`,
  });
  return undefined;
}
