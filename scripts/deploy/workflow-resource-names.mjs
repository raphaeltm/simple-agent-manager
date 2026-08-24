#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const MAX_ENVIRONMENT_LENGTH = 63;
const MAX_PREFIX_LENGTH = 40;
const MAX_GATEWAY_ID_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
const MAX_BUCKET_LENGTH = 63;

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function assertSafeValue(name, value) {
  if (value === undefined || value === null) {
    throw new Error(`${name} is required.`);
  }
  if (value === '') {
    throw new Error(`${name} is required.`);
  }
  if (hasControlCharacters(value)) {
    throw new Error(`${name} must not contain multiline or control characters.`);
  }
  if (value.startsWith('-')) {
    throw new Error(`${name} must not start with '-'.`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`${name} must not contain path separators.`);
  }
}

export function validateDeploymentEnvironment(value) {
  assertSafeValue('environment', value);
  if (value.length > MAX_ENVIRONMENT_LENGTH) {
    throw new Error(`environment must be ${MAX_ENVIRONMENT_LENGTH} characters or fewer.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('environment may contain only letters, numbers, underscores, and hyphens.');
  }
  return value;
}

export function stackNameForEnvironment(environment) {
  const validated = validateDeploymentEnvironment(environment);
  if (validated === 'production') {
    return 'prod';
  }
  if (validated === 'staging') {
    return 'staging';
  }
  return validated;
}

export function validateBaseDomain(value) {
  assertSafeValue('BASE_DOMAIN', value);
  if (value.length > MAX_DOMAIN_LENGTH) {
    throw new Error(`BASE_DOMAIN must be ${MAX_DOMAIN_LENGTH} characters or fewer.`);
  }
  const labels = value.split('.');
  if (labels.length < 2) {
    throw new Error('BASE_DOMAIN must contain at least one dot.');
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new Error('BASE_DOMAIN contains an invalid DNS label length.');
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)) {
      throw new Error('BASE_DOMAIN must be a DNS name with alphanumeric/hyphen labels.');
    }
  }
  return value;
}

export function validateResourcePrefix(value) {
  assertSafeValue('RESOURCE_PREFIX', value);
  if (value.length > MAX_PREFIX_LENGTH) {
    throw new Error(`RESOURCE_PREFIX must be ${MAX_PREFIX_LENGTH} characters or fewer.`);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)) {
    throw new Error(
      'RESOURCE_PREFIX may contain only lowercase letters, numbers, and internal hyphens.'
    );
  }
  return value;
}

export function validateBucketName(value) {
  assertSafeValue('PULUMI_STATE_BUCKET', value);
  if (value.length < 3 || value.length > MAX_BUCKET_LENGTH) {
    throw new Error(`PULUMI_STATE_BUCKET must be 3-${MAX_BUCKET_LENGTH} characters long.`);
  }
  if (value.includes('..') || value.includes('.-') || value.includes('-.')) {
    throw new Error('PULUMI_STATE_BUCKET contains an invalid dot/hyphen sequence.');
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) {
    throw new Error(
      'PULUMI_STATE_BUCKET may contain only lowercase letters, numbers, dots, and hyphens.'
    );
  }
  return value;
}

export function validateGatewayId(value) {
  assertSafeValue('AI_GATEWAY_ID', value);
  if (value.length > MAX_GATEWAY_ID_LENGTH) {
    throw new Error(`AI_GATEWAY_ID must be ${MAX_GATEWAY_ID_LENGTH} characters or fewer.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('AI_GATEWAY_ID may contain only letters, numbers, underscores, and hyphens.');
  }
  return value;
}

export function derivePrefix(baseDomain) {
  const validated = validateBaseDomain(baseDomain);
  return `s${createHash('sha256').update(validated).digest('hex').slice(0, 6)}`;
}

export function resolvePrefix({ explicitPrefix, baseDomain }) {
  if (explicitPrefix) {
    return validateResourcePrefix(explicitPrefix);
  }
  if (!baseDomain) {
    throw new Error('BASE_DOMAIN is required when RESOURCE_PREFIX is not set.');
  }
  return derivePrefix(baseDomain);
}

export function resolveResourceNames(env, mode) {
  const environment = env.DEPLOY_ENVIRONMENT ?? env.INPUT_ENVIRONMENT;
  const requiresBaseDomain = mode === 'deploy' || mode === 'teardown' || mode === 'marketing';
  const baseDomain = env.BASE_DOMAIN ? validateBaseDomain(env.BASE_DOMAIN) : undefined;
  if (requiresBaseDomain && !baseDomain) {
    throw new Error('BASE_DOMAIN is required.');
  }
  const prefix = resolvePrefix({
    explicitPrefix: env.RESOURCE_PREFIX,
    baseDomain,
  });
  const stack = environment ? stackNameForEnvironment(environment) : undefined;
  const pulumiStateBucket = validateBucketName(
    env.PULUMI_STATE_BUCKET || `${prefix}-pulumi-state`
  );
  const aiGateway = validateGatewayId(env.AI_GATEWAY_ID || prefix);

  const outputs = {
    prefix,
    resource_prefix: prefix,
    pulumi_state_bucket: pulumiStateBucket,
    pages_project: `${prefix}-www`,
    ai_gateway: aiGateway,
  };

  if (baseDomain) {
    outputs.base_domain = baseDomain;
    outputs.www_domain = `www.${baseDomain}`;
  }

  if (environment) {
    outputs.environment = validateDeploymentEnvironment(environment);
  }
  if (stack) {
    outputs.stack = stack;
    outputs.api_worker = `${prefix}-api-${stack}`;
    outputs.tail_worker = `${prefix}-tail-worker-${stack}`;
    outputs.web_pages_project = `${prefix}-web-${stack}`;
    outputs.pages_project = outputs.web_pages_project;
    outputs.www_project = `${prefix}-www`;
    outputs.analytics_dataset = `${prefix}_analytics`;
    if (baseDomain) {
      outputs.api_url = `https://api.${baseDomain}`;
      outputs.app_url = `https://app.${baseDomain}`;
      outputs.pages_domain = `app.${baseDomain}`;
    }
  }

  if (mode === 'marketing') {
    outputs.base = baseDomain;
    outputs.www = `www.${baseDomain}`;
  }

  return outputs;
}

export function writeGitHubOutputs(outputs, outputPath = process.env.GITHUB_OUTPUT) {
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    if (value === undefined) {
      continue;
    }
    if (hasControlCharacters(String(value))) {
      throw new Error(`Refusing to write control characters to GITHUB_OUTPUT for ${key}.`);
    }
    lines.push(`${key}=${value}`);
  }

  if (outputPath) {
    appendFileSync(outputPath, `${lines.join('\n')}\n`);
  } else {
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

function main() {
  const mode = process.argv[2];
  if (!['deploy', 'teardown', 'marketing', 'pulumi'].includes(mode)) {
    throw new Error('Usage: workflow-resource-names.mjs <deploy|teardown|marketing|pulumi>');
  }

  const outputs = resolveResourceNames(process.env, mode);
  writeGitHubOutputs(outputs);

  if (mode === 'deploy' || mode === 'pulumi') {
    console.log(`Stack: ${outputs.stack} for environment: ${outputs.environment}`);
    console.log(`Resource prefix: ${outputs.prefix}`);
  } else if (mode === 'teardown') {
    console.log('### Resource Names');
    console.log(`- Stack: ${outputs.stack}`);
    console.log(`- API Worker: ${outputs.api_worker}`);
    console.log(`- Tail Worker: ${outputs.tail_worker}`);
    console.log(`- Pages Project: ${outputs.web_pages_project}`);
    console.log(`- WWW Project: ${outputs.pages_project}`);
    console.log(`- AI Gateway: ${outputs.ai_gateway}`);
    console.log(`- Base Domain: ${outputs.base_domain}`);
  } else {
    console.log(`Base domain: ${outputs.base_domain}`);
    console.log(`WWW domain: ${outputs.www_domain}`);
    console.log(`Pages project: ${outputs.pages_project}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
