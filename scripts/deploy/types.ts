/**
 * Shared types for deployment scripts.
 * Based on data-model.md specification.
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  zoneId: string;
  baseDomain: string;
}

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  appId: string;
  appPrivateKey: string;
}

export interface HetznerConfig {
  apiToken: string;
}

export interface SecurityConfig {
  encryptionKey: string;
  jwtPrivateKey: string;
  jwtPublicKey: string;
}

export interface DeploymentOptions {
  skipHealthCheck: boolean;
  skipDns: boolean;
  verbose: boolean;
  dryRun: boolean;
  resume: boolean;
}

export interface DeploymentConfig {
  environment: 'development' | 'staging' | 'production';
  cloudflare: CloudflareConfig;
  github?: GitHubConfig;
  hetzner?: HetznerConfig;
  security: SecurityConfig;
  options: DeploymentOptions;
}

// ============================================================================
// Resource Types
// ============================================================================

export interface D1Resource {
  databaseId: string;
  databaseName: string;
}

export interface KVResource {
  namespaceId: string;
  namespaceName: string;
}

export interface R2Resource {
  bucketName: string;
}

export interface WorkerResource {
  name: string;
  url: string;
}

export interface PagesResource {
  projectName: string;
  url: string;
}

export interface DnsRecord {
  id: string;
  name: string;
  type: 'CNAME' | 'A';
  content: string;
  proxied: boolean;
}

export interface ProvisionedResources {
  d1?: D1Resource;
  kv?: KVResource;
  r2?: R2Resource;
  worker?: WorkerResource;
  pages?: PagesResource;
}

// ============================================================================
// State Types
// ============================================================================

export type DeploymentStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface DeploymentStep {
  name: string;
  status: StepStatus;
  startTime?: string;
  endTime?: string;
  error?: string;
  output?: string;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  lastRun?: string;
}

export interface DeploymentState {
  version: string;
  environment: string;
  timestamp: string;
  status: DeploymentStatus;
  resources: ProvisionedResources;
  dnsRecords: DnsRecord[];
  steps: DeploymentStep[];
  secretsConfigured: string[];
  migrations: MigrationStatus;
}

// ============================================================================
// Preflight Check Types
// ============================================================================

export interface VersionCheck {
  required: string;
  actual: string;
  passed: boolean;
}

export interface ExistingResources {
  d1: boolean;
  kv: boolean;
  r2: boolean;
  worker: boolean;
  pages: boolean;
}

export interface PreflightChecks {
  nodeVersion: VersionCheck;
  pnpmVersion: VersionCheck;
  wranglerVersion: VersionCheck;
  packagesInstalled: boolean;
  lockfileValid: boolean;
  cloudflareAuth: boolean;
  githubAppValid: boolean;
  domainOwnership: boolean;
  existingResources: ExistingResources;
}

export interface PreflightWarning {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface PreflightError {
  code: string;
  message: string;
  remediation: string;
}

export interface PreflightResult {
  timestamp: string;
  checks: PreflightChecks;
  warnings: PreflightWarning[];
  errors: PreflightError[];
  canProceed: boolean;
}

// ============================================================================
// Health Check Types
// ============================================================================

export interface EndpointHealth {
  url: string;
  status: number;
  responseTime: number;
  healthy: boolean;
  version?: string;
}

export interface ResourceHealth {
  connected: boolean;
  details?: Record<string, unknown>;
}

export interface DnsHealth {
  recordsCreated: boolean;
  propagated: boolean;
  resolvable: {
    api: boolean;
    app: boolean;
    wildcard: boolean;
  };
}

export interface HealthCheckResult {
  timestamp: string;
  environment: string;
  endpoints: {
    api: EndpointHealth;
    web: EndpointHealth;
  };
  resources: {
    d1: ResourceHealth & { migrationsApplied: boolean; tableCount: number };
    kv: ResourceHealth;
    r2: ResourceHealth & { objectCount: number };
  };
  dns: DnsHealth;
  overall: {
    healthy: boolean;
    issues: string[];
    warnings: string[];
  };
}

// ============================================================================
// CLI Types
// ============================================================================

export interface CLIArgs {
  environment?: 'development' | 'staging' | 'production';
  verbose?: boolean;
  dryRun?: boolean;
  resume?: boolean;
  skipHealthCheck?: boolean;
  skipDns?: boolean;
  force?: boolean;
  keepData?: boolean;
}

// ============================================================================
// Cloudflare API Response Types
// ============================================================================

export interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

export interface CloudflareD1Database {
  uuid: string;
  name: string;
  created_at: string;
  version: string;
  num_tables: number;
  file_size: number;
}

export interface CloudflareKVNamespace {
  id: string;
  title: string;
  supports_url_encoding: boolean;
}

export interface CloudflareR2Bucket {
  name: string;
  creation_date: string;
  location?: string;
}

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxiable: boolean;
  proxied: boolean;
  ttl: number;
  locked: boolean;
  created_on: string;
  modified_on: string;
}

export interface CloudflareWorker {
  id: string;
  name: string;
  created_on: string;
  modified_on: string;
}

// ============================================================================
// Constants
// ============================================================================

export const DEPLOYMENT_STATE_VERSION = '1.0.0';

// Note: Resource naming is centralized in config.ts (DEPLOYMENT_CONFIG.resources)
// Do NOT add resource naming constants here - use DEPLOYMENT_CONFIG instead.

export const REQUIRED_SECRETS = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_SLUG',
  'CF_API_TOKEN',
  'CF_ZONE_ID',
  'ENCRYPTION_KEY',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
] as const;

// Note: HETZNER_TOKEN is NOT a platform secret.
// Users provide their own tokens via Settings UI, stored encrypted per-user.
// See docs/architecture/credential-security.md
export const OPTIONAL_SECRETS = [] as const;

export const DNS_RECORDS = ['api', 'app', '*'] as const;

// ============================================================================
// Pulumi Output Types (from infra/)
// ============================================================================

/**
 * Pulumi stack outputs consumed by sync-wrangler-config.ts
 */
export interface PulumiOutputs {
  d1DatabaseId: string;
  d1DatabaseName: string;
  kvId: string;
  kvName: string;
  r2Name: string;
  dnsIds: {
    api: string;
    app: string;
    wildcard: string;
  };
  hostnames: {
    api: string;
    app: string;
  };
  stackSummary: {
    stack: string;
    baseDomain: string;
    resources: {
      d1: string;
      kv: string;
      r2: string;
    };
  };
  cloudflareAccountId: string;
}

/**
 * Wrangler.toml bindings section for type-safe manipulation
 */
export interface WranglerTomlBindings {
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir?: string;
  }>;
  kv_namespaces?: Array<{
    binding: string;
    id: string;
  }>;
  r2_buckets?: Array<{
    binding: string;
    bucket_name: string;
  }>;
}

/**
 * Partial wrangler.toml structure
 */
export interface WranglerToml extends WranglerTomlBindings {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  vars?: Record<string, string>;
  env?: Record<string, WranglerEnvConfig>;
  [key: string]: unknown;
}

export interface WranglerEnvConfig {
  name?: string;
  account_id?: string;
  routes?: Array<{ pattern: string; zone_name?: string; zone_id?: string; custom_domain?: boolean }>;
  d1_databases?: WranglerTomlBindings["d1_databases"];
  kv_namespaces?: WranglerTomlBindings["kv_namespaces"];
  r2_buckets?: WranglerTomlBindings["r2_buckets"];
  vars?: Record<string, string>;
  [key: string]: unknown;
}
