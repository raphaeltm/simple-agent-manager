/**
 * Configuration validation with Zod schemas.
 * Provides type-safe validation for deployment configuration.
 */

import { z } from 'zod';
import type { DeploymentConfig, DeploymentOptions } from '../types.js';

// ============================================================================
// Zod Schemas
// ============================================================================

export const CloudflareConfigSchema = z.object({
  accountId: z
    .string()
    .min(1, 'Cloudflare account ID is required')
    .regex(/^[a-f0-9]{32}$/i, 'Invalid Cloudflare account ID format'),
  apiToken: z.string().min(1, 'Cloudflare API token is required'),
  zoneId: z
    .string()
    .min(1, 'Cloudflare zone ID is required')
    .regex(/^[a-f0-9]{32}$/i, 'Invalid Cloudflare zone ID format'),
  baseDomain: z
    .string()
    .min(1, 'Base domain is required')
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
      'Invalid domain format'
    ),
});

export const GitHubConfigSchema = z.object({
  clientId: z.string().min(1, 'GitHub client ID is required'),
  clientSecret: z.string().min(1, 'GitHub client secret is required'),
  appId: z
    .string()
    .min(1, 'GitHub App ID is required')
    .regex(/^\d+$/, 'GitHub App ID must be numeric'),
  appPrivateKey: z
    .string()
    .min(1, 'GitHub App private key is required')
    .refine(
      (key) =>
        key.includes('-----BEGIN') &&
        key.includes('-----END') &&
        key.includes('PRIVATE KEY'),
      'Invalid PEM private key format'
    ),
});

export const HetznerConfigSchema = z.object({
  apiToken: z.string().min(1, 'Hetzner API token is required'),
});

export const SecurityConfigSchema = z.object({
  encryptionKey: z
    .string()
    .min(1, 'Encryption key is required')
    .refine((key) => {
      try {
        const decoded = Buffer.from(key, 'base64');
        return decoded.length === 32; // AES-256 requires 32 bytes
      } catch {
        return false;
      }
    }, 'Encryption key must be 32 bytes base64 encoded'),
  jwtPrivateKey: z
    .string()
    .min(1, 'JWT private key is required')
    .refine(
      (key) =>
        key.includes('-----BEGIN') &&
        key.includes('-----END') &&
        key.includes('PRIVATE KEY'),
      'Invalid JWT private key format'
    ),
  jwtPublicKey: z
    .string()
    .min(1, 'JWT public key is required')
    .refine(
      (key) =>
        key.includes('-----BEGIN') &&
        key.includes('-----END') &&
        key.includes('PUBLIC KEY'),
      'Invalid JWT public key format'
    ),
});

export const DeploymentOptionsSchema = z.object({
  skipHealthCheck: z.boolean().default(false),
  skipDns: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  resume: z.boolean().default(false),
});

export const EnvironmentSchema = z.enum([
  'development',
  'staging',
  'production',
]);

export const DeploymentConfigSchema = z.object({
  environment: EnvironmentSchema,
  cloudflare: CloudflareConfigSchema,
  github: GitHubConfigSchema.optional(),
  hetzner: HetznerConfigSchema.optional(),
  security: SecurityConfigSchema,
  options: DeploymentOptionsSchema,
});

// ============================================================================
// Validation Functions
// ============================================================================

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

export function validateDeploymentConfig(
  config: unknown
): ValidationResult<DeploymentConfig> {
  const result = DeploymentConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data as DeploymentConfig };
  }

  return {
    success: false,
    errors: result.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    })),
  };
}

export function validateCloudflareConfig(
  config: unknown
): ValidationResult<z.infer<typeof CloudflareConfigSchema>> {
  const result = CloudflareConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    errors: result.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    })),
  };
}

export function validateGitHubConfig(
  config: unknown
): ValidationResult<z.infer<typeof GitHubConfigSchema>> {
  const result = GitHubConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    errors: result.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    })),
  };
}

export function validateSecurityConfig(
  config: unknown
): ValidationResult<z.infer<typeof SecurityConfigSchema>> {
  const result = SecurityConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    errors: result.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    })),
  };
}

// ============================================================================
// Configuration Loading
// ============================================================================

export interface EnvironmentVariables {
  // Required
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  BASE_DOMAIN?: string;

  // GitHub (optional for basic deployment)
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;

  // Hetzner (optional)
  HETZNER_TOKEN?: string;

  // Security keys (auto-generated if missing)
  ENCRYPTION_KEY?: string;
  JWT_PRIVATE_KEY?: string;
  JWT_PUBLIC_KEY?: string;

  // Options
  DEPLOY_ENVIRONMENT?: string;
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv | EnvironmentVariables,
  options: Partial<DeploymentOptions> = {}
): Partial<DeploymentConfig> {
  const config: Partial<DeploymentConfig> = {
    environment:
      (env.DEPLOY_ENVIRONMENT as DeploymentConfig['environment']) ||
      'production',
    options: {
      skipHealthCheck: options.skipHealthCheck ?? false,
      skipDns: options.skipDns ?? false,
      verbose: options.verbose ?? false,
      dryRun: options.dryRun ?? false,
      resume: options.resume ?? false,
    },
  };

  // Cloudflare config
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID) {
    config.cloudflare = {
      apiToken: env.CF_API_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
      zoneId: env.CF_ZONE_ID,
      baseDomain: env.BASE_DOMAIN || '',
    };
  }

  // GitHub config (optional)
  if (
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_PRIVATE_KEY
  ) {
    config.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      appId: env.GITHUB_APP_ID,
      appPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    };
  }

  // Hetzner config (optional)
  if (env.HETZNER_TOKEN) {
    config.hetzner = {
      apiToken: env.HETZNER_TOKEN,
    };
  }

  // Security config (optional - will be auto-generated if missing)
  if (env.ENCRYPTION_KEY && env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
    config.security = {
      encryptionKey: env.ENCRYPTION_KEY,
      jwtPrivateKey: env.JWT_PRIVATE_KEY,
      jwtPublicKey: env.JWT_PUBLIC_KEY,
    };
  }

  return config;
}

// ============================================================================
// Default Options
// ============================================================================

export function getDefaultOptions(): DeploymentOptions {
  return {
    skipHealthCheck: false,
    skipDns: false,
    verbose: false,
    dryRun: false,
    resume: false,
  };
}

// ============================================================================
// Format validation errors for display
// ============================================================================

export function formatValidationErrors(
  errors: Array<{ path: string; message: string }>
): string[] {
  return errors.map((err) => {
    if (err.path) {
      return `${err.path}: ${err.message}`;
    }
    return err.message;
  });
}
