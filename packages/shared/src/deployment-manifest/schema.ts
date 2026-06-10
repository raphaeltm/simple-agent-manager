/**
 * Deployment Manifest Schema (v1)
 *
 * Zod schemas for the normalized SAM deployment manifest.
 * This is the canonical contract between agents, the control plane,
 * and deployment nodes. Compose files are parsed into this format;
 * the node receives a server-rendered Compose file derived from it.
 *
 * See: /research/app-deployment/06-compose-safety-and-manifest.md
 */

import { z } from 'zod';

// =============================================================================
// Primitives
// =============================================================================

/** SHA-256 digest — 64 hex chars after the `sha256:` prefix. */
const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/** Service names: lowercase alphanumeric + hyphens, 1-63 chars. */
const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Volume names: same rules as service names. */
const VOLUME_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Secret names: alphanumeric, hyphens, underscores, 1-128 chars. */
const SECRET_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// =============================================================================
// Image
// =============================================================================

export const ImageSchema = z
  .object({
    registry: z.string().min(1, 'Registry must not be empty'),
    repository: z.string().min(1, 'Repository must not be empty'),
    digest: z
      .string()
      .regex(SHA256_DIGEST_RE, 'Image digest must be a sha256 digest (sha256:<64 hex chars>). Mutable tags are not allowed.'),
  })
  .strict();

export type Image = z.infer<typeof ImageSchema>;

// =============================================================================
// Environment variable value — plain string OR secret reference
// =============================================================================

export const SecretRefSchema = z
  .object({
    secret: z
      .string()
      .regex(SECRET_NAME_RE, 'Secret name must be 1-128 alphanumeric, hyphen, or underscore characters'),
  })
  .strict();

export type SecretRef = z.infer<typeof SecretRefSchema>;

export const EnvValueSchema = z.union([z.string(), SecretRefSchema]);

export type EnvValue = z.infer<typeof EnvValueSchema>;

// =============================================================================
// Service volume mount
// =============================================================================

export const ServiceVolumeMountSchema = z
  .object({
    name: z.string().regex(VOLUME_NAME_RE, 'Volume name must be lowercase alphanumeric with optional hyphens, 1-63 chars'),
    mountPath: z.string().min(1, 'Mount path must not be empty'),
  })
  .strict();

export type ServiceVolumeMount = z.infer<typeof ServiceVolumeMountSchema>;

// =============================================================================
// Resource limits
// =============================================================================

export const ResourceLimitsSchema = z
  .object({
    memoryLimitMb: z.number().int().positive('Memory limit must be a positive integer (MB)'),
    cpuLimit: z.number().positive('CPU limit must be a positive number'),
  })
  .strict();

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

// =============================================================================
// Health check
// =============================================================================

export const HealthCheckSchema = z
  .object({
    path: z.string().min(1, 'Health check path must not be empty'),
    port: z.number().int().min(1).max(65535, 'Port must be between 1 and 65535'),
    expectedStatus: z.number().int().min(100).max(599, 'Expected status must be a valid HTTP status code (100-599)'),
  })
  .strict();

export type HealthCheck = z.infer<typeof HealthCheckSchema>;

// =============================================================================
// Service
// =============================================================================

export const ServiceSchema = z
  .object({
    image: ImageSchema,
    command: z.array(z.string()).optional(),
    env: z.record(z.string(), EnvValueSchema).default({}),
    volumes: z.array(ServiceVolumeMountSchema).default([]),
    resources: ResourceLimitsSchema.optional(),
    healthCheck: HealthCheckSchema.optional(),
  })
  .strict();

export type Service = z.infer<typeof ServiceSchema>;

// =============================================================================
// Volume declaration
// =============================================================================

export const VolumeDeclarationSchema = z
  .object({
    sizeHintMb: z.number().int().positive('Volume size hint must be a positive integer (MB)').optional(),
  })
  .strict();

export type VolumeDeclaration = z.infer<typeof VolumeDeclarationSchema>;

// =============================================================================
// Route
// =============================================================================

export const RouteSchema = z
  .object({
    service: z.string().min(1, 'Route service must not be empty'),
    port: z.number().int().min(1).max(65535, 'Port must be between 1 and 65535'),
    mode: z.enum(['public', 'private']),
  })
  .strict();

export type Route = z.infer<typeof RouteSchema>;

// =============================================================================
// Hooks
// =============================================================================

export const PreFlightHookSchema = z
  .object({
    service: z.string().min(1, 'Hook service must not be empty'),
    command: z.array(z.string()).min(1, 'Hook command must have at least one element'),
    timeoutSeconds: z
      .number()
      .int()
      .positive('Timeout must be a positive integer')
      .max(3600, 'Timeout must not exceed 3600 seconds'),
  })
  .strict();

export type PreFlightHook = z.infer<typeof PreFlightHookSchema>;

export const HooksSchema = z
  .object({
    preFlight: PreFlightHookSchema.optional(),
  })
  .strict();

export type Hooks = z.infer<typeof HooksSchema>;

// =============================================================================
// Top-level Manifest
// =============================================================================

/**
 * The base manifest schema enforces shape/type/format rules via Zod.
 * Cross-reference validation (route→service, volume→volume) is handled
 * separately in `validateManifest()` to produce friendlier errors.
 */
export const DeploymentManifestSchema = z
  .object({
    version: z.literal(1),
    services: z
      .record(
        z.string().regex(SERVICE_NAME_RE, 'Service name must be lowercase alphanumeric with optional hyphens, 1-63 chars'),
        ServiceSchema,
      )
      .refine((s) => Object.keys(s).length > 0, { message: 'At least one service must be defined' }),
    volumes: z.record(
      z.string().regex(VOLUME_NAME_RE, 'Volume name must be lowercase alphanumeric with optional hyphens, 1-63 chars'),
      VolumeDeclarationSchema,
    ).default({}),
    routes: z.array(RouteSchema).min(1, 'At least one route must be defined'),
    hooks: HooksSchema.optional(),
  })
  .strict();

export type DeploymentManifest = z.infer<typeof DeploymentManifestSchema>;
