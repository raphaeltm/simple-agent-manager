/**
 * Centralized deployment configuration
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read version from package.json
const packageJsonPath = resolve(import.meta.dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

/**
 * Derive a short, DNS-safe prefix from a domain name.
 * Uses first 6 hex chars of SHA-256, prefixed with 's' to ensure it starts
 * with a letter. Must match the derivation in infra/resources/config.ts.
 */
function derivePrefix(domain: string): string {
  const hash = createHash('sha256').update(domain).digest('hex');
  return `s${hash.slice(0, 6)}`;
}

function getDeploymentPrefix(): string {
  const explicitPrefix = process.env.RESOURCE_PREFIX?.trim();
  if (explicitPrefix) {
    return explicitPrefix;
  }

  const baseDomain = process.env.BASE_DOMAIN?.trim();
  if (!baseDomain) {
    throw new Error(
      'RESOURCE_PREFIX or BASE_DOMAIN is required to derive deployment resource names'
    );
  }

  return derivePrefix(baseDomain);
}

export const DEPLOYMENT_CONFIG = {
  /**
   * Resource name prefix used across all infrastructure.
   * Explicit RESOURCE_PREFIX takes precedence; otherwise derived from
   * BASE_DOMAIN so forks get unique names without extra configuration.
   */
  get prefix(): string {
    return getDeploymentPrefix();
  },

  /**
   * Stack name mappings
   */
  stackMapping: {
    production: 'prod',
    staging: 'staging',
    development: 'dev',
  } as const,

  /**
   * Reverse mapping for environment lookup
   */
  getEnvironmentFromStack(stack: string): string {
    const entries = Object.entries(DEPLOYMENT_CONFIG.stackMapping);
    const match = entries.find(([_, stackName]) => stackName === stack);
    return match ? match[0] : stack;
  },

  /**
   * Get stack name from environment
   */
  getStackFromEnvironment(env: string): string {
    return (
      DEPLOYMENT_CONFIG.stackMapping[env as keyof typeof DEPLOYMENT_CONFIG.stackMapping] || env
    );
  },

  /**
   * Application version
   */
  version: packageJson.version as string,

  /**
   * Cloudflare configuration
   */
  cloudflare: {
    r2Endpoint: (accountId: string) => `${accountId}.r2.cloudflarestorage.com`,
    r2Region: 'auto',
    defaultPort: parseInt(process.env.WRANGLER_PORT || '8787'),
  },

  /**
   * Default Pulumi state bucket name
   */
  getPulumiStateBucket: (environment?: string) => {
    const prefix = DEPLOYMENT_CONFIG.prefix;
    const env = environment ? `-${environment}` : '';
    return `${prefix}-pulumi-state${env}`;
  },

  /**
   * Resource naming conventions
   */
  resources: {
    database: (stack: string) => `${DEPLOYMENT_CONFIG.prefix}-${stack}`,
    kvNamespace: (stack: string) => `${DEPLOYMENT_CONFIG.prefix}-${stack}-sessions`,
    r2Bucket: (stack: string) => `${DEPLOYMENT_CONFIG.prefix}-${stack}-assets`,
    workerName: (stack: string) => `${DEPLOYMENT_CONFIG.prefix}-api-${stack}`,
    tailWorkerName: (stack: string) => `${DEPLOYMENT_CONFIG.prefix}-tail-worker-${stack}`,
    pagesProject: (stack: string) => `${DEPLOYMENT_CONFIG.prefix}-web-${stack}`,
  },

  /**
   * DNS subdomain configuration
   */
  dns: {
    api: 'api',
    app: 'app',
    wildcard: '*',
  },

  /**
   * Development environment defaults
   */
  development: {
    baseDomain: 'localhost:8787',
    apiUrl: 'http://localhost:8787',
  },
} as const;

export type DeploymentConfig = typeof DEPLOYMENT_CONFIG;
