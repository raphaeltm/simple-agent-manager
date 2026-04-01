/**
 * Centralized deployment configuration
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read version from package.json
const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

export const DEPLOYMENT_CONFIG = {
  /**
   * Resource name prefix used across all infrastructure
   */
  prefix: process.env.RESOURCE_PREFIX || "sam",

  /**
   * Stack name mappings
   */
  stackMapping: {
    production: "prod",
    staging: "staging",
    development: "dev",
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
    return DEPLOYMENT_CONFIG.stackMapping[env as keyof typeof DEPLOYMENT_CONFIG.stackMapping] || env;
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
    r2Region: "auto",
    defaultPort: parseInt(process.env.WRANGLER_PORT || "8787"),
  },

  /**
   * Default Pulumi state bucket name
   */
  getPulumiStateBucket: (environment?: string) => {
    const prefix = DEPLOYMENT_CONFIG.prefix;
    const env = environment ? `-${environment}` : "";
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
    api: "api",
    app: "app",
    wildcard: "*",
  },

  /**
   * Development environment defaults
   */
  development: {
    baseDomain: "localhost:8787",
    apiUrl: "http://localhost:8787",
  },
} as const;

export type DeploymentConfig = typeof DEPLOYMENT_CONFIG;

/**
 * GitHub Actions reserves the GITHUB_* prefix, so GitHub Environment secrets
 * use GH_*. The deployment script (configure-secrets.sh) maps them to
 * GITHUB_* Worker secrets at deploy time.
 *
 * This is the canonical reference for the mapping. If you add a new GitHub
 * secret, add it here AND in configure-secrets.sh's GITHUB_SECRET_MAPPINGS.
 *
 * See: CLAUDE.md "Env Var Naming: GH_ vs GITHUB_"
 * See: .claude/rules/07-env-and-urls.md
 */
export const GITHUB_SECRET_MAPPINGS: Record<string, string> = {
  // Worker secret name → GitHub Environment secret name
  GITHUB_CLIENT_ID: "GH_CLIENT_ID",
  GITHUB_CLIENT_SECRET: "GH_CLIENT_SECRET",
  GITHUB_APP_ID: "GH_APP_ID",
  GITHUB_APP_PRIVATE_KEY: "GH_APP_PRIVATE_KEY",
  GITHUB_APP_SLUG: "GH_APP_SLUG",
} as const;