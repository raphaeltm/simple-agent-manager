/** Legacy GitHub CI adapter. The existing workflow remains the environment mapping
 * equivalence is checked against a non-secret expression manifest until cutover.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import {
  type InstallerEngineConfig,
  stackNameForEnvironment,
  validateEngineConfig,
} from './installer-engine-contract.js';

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
}
export interface CiEnvironmentManifest {
  jobs: { deploy: { env?: Record<string, string>; steps: WorkflowStep[] } };
}
export interface LegacyCiInput {
  sourceCommit: string;
  environment: string;
  dryRun?: boolean;
  skipAgent?: boolean;
  variables: Record<string, string>;
  secrets: Record<string, string>;
}
const MAPPED_STEPS = [
  'Pulumi Refresh',
  'Pulumi Up',
  'Configure Agent Email (preview)',
  'Sync Wrangler Config (API + Tail Worker)',
  'Build Applications',
  'Run Database Migrations With Safety Gates',
  'Configure Worker Secrets',
];
export function legacyCiWorkflow(root: string): CiEnvironmentManifest {
  return parse(
    readFileSync(join(root, '.github/workflows/deploy-reusable.yml'), 'utf8')
  ) as CiEnvironmentManifest;
}
export function legacyCiEnvironmentManifest(root: string): CiEnvironmentManifest {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'scripts/deploy/installer-engine-ci-env.json'), 'utf8')
  );
  const manifest = parsed as CiEnvironmentManifest;
  if (!manifest?.jobs?.deploy || !Array.isArray(manifest.jobs.deploy.steps))
    throw new Error('Invalid CI environment manifest');
  const initial = manifest.jobs.deploy.steps.find(
    (step) => step.name === 'Sync Wrangler Config (API + Tail Worker)'
  );
  if (!initial?.env) throw new Error('Missing CI Worker environment mapping');
  return {
    jobs: {
      deploy: {
        ...manifest.jobs.deploy,
        steps: [
          ...manifest.jobs.deploy.steps,
          { name: 'Re-sync Wrangler Config (add tail_consumers)', env: initial.env },
        ],
      },
    },
  };
}
export function resolveLegacyCiEnvironment(
  workflow: CiEnvironmentManifest,
  input: LegacyCiInput,
  config: InstallerEngineConfig
): NodeJS.ProcessEnv {
  const steps = workflow.jobs.deploy.steps;
  const initial = steps.find(
    (step) => step.name === 'Sync Wrangler Config (API + Tail Worker)'
  )?.env;
  const repeat = steps.find(
    (step) => step.name === 'Re-sync Wrangler Config (add tail_consumers)'
  )?.env;
  if (
    !initial ||
    !repeat ||
    JSON.stringify(Object.entries(initial).sort()) !== JSON.stringify(Object.entries(repeat).sort())
  ) {
    throw new Error('CI Wrangler environment mappings diverged');
  }
  const outputs: Record<string, string> = {
    'pulumi-select.stack_name': stackNameForEnvironment(config.environment),
    'deploy_resources.base_domain': config.baseDomain,
    'deploy_resources.prefix': config.prefix ?? '',
    'deploy_resources.environment': config.environment,
    // Engine resolves actual release identity before either sync.
    'deploy-sha.agent_version': '',
  };
  const evaluate = (value: string): string =>
    value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_whole, expression: string) => {
      const setting = /^(vars|secrets)\.([A-Z_0-9]+)(?: \|\| '([^']*)')?$/.exec(expression);
      if (setting)
        return (
          (setting[1] === 'vars' ? input.variables : input.secrets)[setting[2] ?? ''] ||
          setting[3] ||
          ''
        );
      const output = /^steps\.([a-z_-]+)\.outputs\.([a-z_]+)$/.exec(expression);
      if (output && `${output[1]}.${output[2]}` in outputs)
        return outputs[`${output[1]}.${output[2]}`] ?? '';
      throw new Error('Unsupported CI environment expression');
    });
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(workflow.jobs.deploy.env ?? {}))
    environment[name] = evaluate(value);
  for (const name of MAPPED_STEPS) {
    const step = steps.find((candidate) => candidate.name === name);
    if (!step?.env) throw new Error('Required CI environment mapping missing');
    for (const [key, value] of Object.entries(step.env)) environment[key] = evaluate(String(value));
  }
  return environment;
}
export function legacyCiInvocation(
  root: string,
  input: LegacyCiInput,
  workflow = legacyCiEnvironmentManifest(root)
): { config: InstallerEngineConfig; environment: NodeJS.ProcessEnv } {
  for (const bag of [input.variables, input.secrets]) {
    if (
      !bag ||
      typeof bag !== 'object' ||
      Object.values(bag).some((value) => typeof value !== 'string')
    )
      throw new Error('Invalid CI environment inputs');
  }
  const config = validateEngineConfig({
    schemaVersion: 1,
    profile: 'legacy-ci',
    sourceCommit: input.sourceCommit,
    accountId: input.secrets.CF_ACCOUNT_ID,
    zoneId: input.secrets.CF_ZONE_ID,
    baseDomain: input.variables.BASE_DOMAIN,
    zoneName: input.variables.CF_ZONE_NAME || input.variables.BASE_DOMAIN,
    environment: input.environment,
    prefix: input.variables.RESOURCE_PREFIX || undefined,
    stateBucket: input.variables.PULUMI_STATE_BUCKET || undefined,
    dryRun: input.dryRun ?? false,
    skipAgent: input.skipAgent ?? false,
    codexBuild: {
      executable: 'bash',
      args: ['scripts/deploy/prepare-codex-runtime-artifact.sh', 'apps/api/container-artifacts'],
    },
    codexPublish: {
      executable: 'bash',
      args: [
        'scripts/deploy/publish-codex-runtime-artifact.sh',
        'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz',
      ],
    },
  });
  return { config, environment: resolveLegacyCiEnvironment(workflow, input, config) };
}

export function parseLegacyCiInput(value: unknown, secretValue: unknown): LegacyCiInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid CI inputs');
  const input = value as Partial<LegacyCiInput>;
  const bag = (candidate: unknown): candidate is Record<string, string> =>
    !!candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    Object.values(candidate).every((entry) => typeof entry === 'string');
  if (
    typeof input.sourceCommit !== 'string' ||
    typeof input.environment !== 'string' ||
    !bag(input.variables) ||
    !bag(secretValue) ||
    (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') ||
    (input.skipAgent !== undefined && typeof input.skipAgent !== 'boolean')
  )
    throw new Error('Invalid CI inputs');
  return {
    sourceCommit: input.sourceCommit,
    environment: input.environment,
    variables: input.variables,
    secrets: secretValue,
    dryRun: input.dryRun,
    skipAgent: input.skipAgent,
  };
}
