import * as crypto from 'node:crypto';
import * as pulumi from '@pulumi/pulumi';

export const DEFAULT_R2_LOCATION = 'WNAM';
export const SUPPORTED_R2_LOCATIONS = ['WNAM', 'ENAM', 'WEUR', 'EEUR', 'APAC', 'OC'] as const;
export type R2Location = (typeof SUPPORTED_R2_LOCATIONS)[number];

export const DEFAULT_PAGES_PRODUCTION_BRANCH = 'main';

export interface ConfigReader {
  get(key: string): string | undefined;
  require(key: string): string;
}

export interface InfraConfig {
  accountId: string;
  zoneId: string;
  baseDomain: string;
  stack: string;
  prefix: string;
  r2Location: R2Location;
  pagesProductionBranch: string;
}

const pulumiConfig = new pulumi.Config();

export function parseInfraConfig(config: ConfigReader, currentStack: string): InfraConfig {
  const baseDomain = requireNonEmptyConfig(config, 'baseDomain');
  const resourcePrefix = optionalNonEmptyConfig(config, 'resourcePrefix');

  return {
    accountId: requireNonEmptyConfig(config, 'cloudflareAccountId'),
    zoneId: requireNonEmptyConfig(config, 'cloudflareZoneId'),
    baseDomain,
    stack: currentStack,
    prefix: resourcePrefix ?? derivePrefix(baseDomain),
    r2Location: parseR2Location(optionalNonEmptyConfig(config, 'r2Location')),
    pagesProductionBranch:
      optionalNonEmptyConfig(config, 'pagesProductionBranch') ?? DEFAULT_PAGES_PRODUCTION_BRANCH,
  };
}

/**
 * Resource name prefix — used to namespace all Cloudflare resources.
 *
 * If `resourcePrefix` is explicitly set in Pulumi config, that value is used.
 * Otherwise, a short 6-character hash is derived from `baseDomain` so that
 * forks automatically get unique resource names without extra configuration.
 * This prevents Cloudflare Pages project name collisions (which are globally
 * unique) and Worker name collisions across different deployments.
 */
const infraConfig = parseInfraConfig(pulumiConfig, pulumi.getStack());

export const accountId = infraConfig.accountId;
export const zoneId = infraConfig.zoneId;
export const baseDomain = infraConfig.baseDomain;
export const stack = infraConfig.stack;
export const prefix = infraConfig.prefix;
export const r2Location = infraConfig.r2Location;
export const pagesProductionBranch = infraConfig.pagesProductionBranch;

export function derivePrefix(domain: string): string {
  const hash = crypto.createHash('sha256').update(domain).digest('hex');
  // Use first 6 hex chars, prefixed with 's' to ensure it starts with a letter
  // (Cloudflare resource names must start with a letter)
  return `s${hash.slice(0, 6)}`;
}

function requireNonEmptyConfig(config: ConfigReader, key: string): string {
  const value = config.require(key).trim();
  if (!value) {
    throw new Error(`Pulumi config "${key}" must not be empty`);
  }
  return value;
}

function optionalNonEmptyConfig(config: ConfigReader, key: string): string | undefined {
  const rawValue = config.get(key);
  if (rawValue === undefined) {
    return undefined;
  }

  const value = rawValue.trim();
  if (!value) {
    throw new Error(`Pulumi config "${key}" must not be empty when set`);
  }
  return value;
}

function parseR2Location(value: string | undefined): R2Location {
  if (value === undefined) {
    return DEFAULT_R2_LOCATION;
  }

  if (SUPPORTED_R2_LOCATIONS.includes(value as R2Location)) {
    return value as R2Location;
  }

  throw new Error(
    `Pulumi config "r2Location" must be one of: ${SUPPORTED_R2_LOCATIONS.join(', ')}`
  );
}
