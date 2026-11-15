/**
 * Deploy step: give each Instant container image a content key and reuse the
 * image already in the account registry when the key is unchanged.
 *
 * Wrangler builds Dockerfiles itself and, on a fresh runner, always pushes a new
 * digest, which starts a container rollout (2026-11: ~6 min build and push plus
 * ~6 min rollout per deploy). Here every image input is keyed
 * (`container-image-inputs.ts`). A registry tag `inputs-<key>` in the repository
 * Wrangler uses records an image built from those inputs:
 *
 * - tag present: deploy its digest. Same digest as the running application means
 *   Wrangler applies no change and starts no rollout.
 * - tag absent: build with Wrangler's flags, push under the tag, deploy the digest.
 *   The rollout gate (`wait-container-rollout.ts`) waits for it as before.
 * - no key, or any lookup/push doubt: no override; Wrangler builds the Dockerfile
 *   exactly as it did before this step existed.
 *
 * The chosen references go to `GITHUB_ENV` as `SAM_CONTAINER_IMAGE_OVERRIDES`, so
 * the later tail-consumer re-sync keeps them, and into the generated env section.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as TOML from '@iarna/toml';

import { fingerprintInputs } from './container-image-fingerprints';
import {
  analyzeDockerfile,
  composeImageKey,
  type InputFingerprints,
} from './container-image-inputs';
import {
  BUILD_FLAGS,
  type ContainerTarget,
  dockerRegistry,
  fetchIo,
  ImageBuildError,
  positiveInteger,
  REGISTRY,
  type RegistryIo,
} from './container-image-registry';

export { BUILD_FLAGS, type ContainerTarget, ImageBuildError, type RegistryIo };
import { createRolloutApi, type Rollout } from './container-rollout';
import { ACCOUNT_IMAGE_REFERENCE } from './installer-engine-prebuilt';
import { containerImageOverrides } from './sync-wrangler-config';
import { containerApplicationNames } from './wait-container-rollout';

export const DEFAULT_FINGERPRINT_TIMEOUT_MS = 180_000;
export const DEFAULT_REGISTRY_CREDENTIAL_MINUTES = 30;
export const MAX_REGISTRY_CREDENTIAL_MINUTES = 120;

export type Outcome = 'reused' | 'built' | 'rebuild-by-wrangler';

export interface Decision {
  className: string;
  key: string | null;
  outcome: Outcome;
  reason: string;
  reference: string | null;
  seconds: number;
}

export interface ResolveDeps {
  accountId: string;
  contextDir: string;
  registry: RegistryIo;
  fingerprint(dockerfile: string): Promise<InputFingerprints>;
  /**
   * True when the application's latest container rollout failed or was
   * cancelled. Throws when that cannot be read. Either way the image is rebuilt
   * to a fresh digest so the deploy starts a new rollout: reusing the digest of a
   * failed rollout would start none, and the rollout gate would fail every deploy.
   */
  latestRolloutFailed(applicationName: string): Promise<boolean>;
  readFile(path: string): string;
  now(): number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decide one image. Only a failed build throws; every other doubt rebuilds via Wrangler. */
export async function resolveContainerImage(
  target: ContainerTarget,
  deps: ResolveDeps
): Promise<Decision> {
  const started = deps.now();
  const decide = (
    outcome: Outcome,
    reason: string,
    key: string | null,
    reference: string | null
  ) => ({
    className: target.className,
    key,
    outcome,
    reason,
    reference,
    seconds: Math.round((deps.now() - started) / 1000),
  });
  const rebuild = (reason: string, key: string | null = null) =>
    decide('rebuild-by-wrangler', reason, key, null);

  const dockerfile = deps.readFile(join(deps.contextDir, target.dockerfile));
  const analysis = analyzeDockerfile(dockerfile);
  if (!analysis.ok) return rebuild(`inputs not keyable: ${analysis.reason}`);
  let key: string;
  try {
    const fingerprints = await deps.fingerprint(dockerfile);
    key = composeImageKey({
      dockerfilePath: target.dockerfile,
      dockerfile,
      inputs: analysis.inputs,
      fingerprints,
      buildFlags: BUILD_FLAGS,
    });
  } catch (error) {
    return rebuild(`fingerprint failed: ${message(error)}`);
  }
  const repository = `${REGISTRY}/${deps.accountId}/${target.repository}`;
  const tag = `inputs-${key}`;
  const reference = (digest: string) => {
    const value = `${repository}@${digest}`;
    if (!ACCOUNT_IMAGE_REFERENCE.test(value))
      throw new Error(`Unexpected image reference ${value}`);
    return value;
  };
  let buildReason = 'no image for these inputs';
  let rolloutFailed: boolean;
  try {
    rolloutFailed = await deps.latestRolloutFailed(target.repository);
  } catch (error) {
    rolloutFailed = true;
    buildReason = `rollout state unreadable (${message(error)}); building a fresh digest`;
  }
  if (rolloutFailed && buildReason === 'no image for these inputs')
    buildReason = 'latest rollout failed; building a fresh digest to roll out again';
  if (!rolloutFailed) {
    try {
      const existing = await deps.registry.lookup(repository, tag);
      if (existing) return decide('reused', 'inputs unchanged', key, reference(existing));
    } catch (error) {
      return rebuild(`registry lookup failed: ${message(error)}`, key);
    }
  }
  try {
    const digest = await deps.registry.buildAndPush(target, repository, tag);
    return decide('built', buildReason, key, reference(digest));
  } catch (error) {
    if (error instanceof ImageBuildError) throw error;
    return rebuild(`push failed: ${message(error)}`, key);
  }
}

/**
 * Point the generated `[env.<environment>]` containers at the chosen images.
 * The env section must exist: the sync step generates it before this runs.
 */
export function applyImageOverrides(
  wranglerToml: string,
  environment: string,
  overrides: Record<string, string>
): string {
  containerImageOverrides(JSON.stringify(overrides));
  if (!Object.keys(overrides).length) return wranglerToml;
  const config = TOML.parse(wranglerToml) as {
    env?: Record<string, { containers?: { class_name: string; image: string }[] }>;
  };
  const containers = config.env?.[environment]?.containers;
  if (!containers?.length) throw new Error(`No generated containers in [env.${environment}]`);
  for (const className of Object.keys(overrides)) {
    const container = containers.find((candidate) => candidate.class_name === className);
    if (!container) throw new Error(`No generated container ${className} in [env.${environment}]`);
    container.image = overrides[className];
  }
  return TOML.stringify(config as TOML.JsonMap);
}

/** Whether the highest-target rollout ended without completing. */
export function latestRolloutFailedIn(
  history: Pick<Rollout, 'status' | 'target_version'>[]
): boolean {
  const latest = [...history].sort((a, b) => b.target_version - a.target_version)[0];
  return latest !== undefined && ['failed', 'cancelled', 'canceled'].includes(latest.status);
}

export function summaryMarkdown(decisions: Decision[]): string {
  const rows = decisions.map(
    (d) =>
      `| ${d.className} | ${d.outcome} | ${d.reason.replace(/[|\r\n]+/g, ' ')} | ${d.key ? d.key.slice(0, 16) : '-'} | ${d.reference ? d.reference.split('@')[1].slice(0, 19) : '-'} | ${d.seconds}s |`
  );
  return [
    '### Container images',
    '',
    '| Class | Outcome | Reason | Key | Digest | Time |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

async function main() {
  const env = process.env;
  const root = resolve(import.meta.dirname, '../..');
  const contextDir = join(root, 'apps/api');
  const tomlPath = join(contextDir, 'wrangler.toml');
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const worker = env.API_WORKER_NAME;
  const environment = env.DEPLOY_ENV;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token || !worker || !environment)
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, API_WORKER_NAME and DEPLOY_ENV are required'
    );
  const toml = readFileSync(tomlPath, 'utf8');
  const topLevel = TOML.parse(toml) as { containers?: { class_name: string; image: string }[] };
  const names = containerApplicationNames(toml, worker, environment);
  const targets: ContainerTarget[] = (topLevel.containers ?? []).map((container, index) => ({
    className: container.class_name,
    dockerfile: container.image.replace(/^\.\//, ''),
    repository: names[index],
  }));
  const timeoutMs = positiveInteger(
    env,
    'CONTAINER_IMAGE_FINGERPRINT_TIMEOUT_MS',
    DEFAULT_FINGERPRINT_TIMEOUT_MS
  );
  const io = fetchIo(timeoutMs);
  const registry = dockerRegistry({
    root,
    contextDir,
    credentialMinutes: positiveInteger(
      env,
      'CONTAINER_REGISTRY_CREDENTIAL_MINUTES',
      DEFAULT_REGISTRY_CREDENTIAL_MINUTES,
      MAX_REGISTRY_CREDENTIAL_MINUTES
    ),
  });
  const deps: ResolveDeps = {
    accountId,
    contextDir,
    registry,
    latestRolloutFailed: async (applicationName) => {
      // A fresh deadline per read: an earlier image's build can take minutes.
      const rollouts = createRolloutApi(accountId, token, AbortSignal.timeout(timeoutMs));
      const application = (await rollouts.applications()).find((a) => a.name === applicationName);
      if (!application) return false; // First install: nothing to roll out again.
      return latestRolloutFailedIn(await rollouts.rollouts(application.id));
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    now: Date.now,
    fingerprint: (dockerfile) => {
      const analysis = analyzeDockerfile(dockerfile);
      if (!analysis.ok) return Promise.reject(new Error(analysis.reason));
      return Promise.race([
        fingerprintInputs({ contextDir, inputs: analysis.inputs, io, uv: env.UV_BIN || 'uv' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref()
        ),
      ]);
    },
  };
  const decisions: Decision[] = [];
  try {
    // Sequential: two concurrent multi-GB builds and pushes compete for one runner.
    for (const target of targets) decisions.push(await resolveContainerImage(target, deps));
  } finally {
    registry.dispose();
  }
  const overrides = Object.fromEntries(
    decisions.filter((d) => d.reference).map((d) => [d.className, d.reference as string])
  );
  writeFileSync(tomlPath, applyImageOverrides(toml, environment, overrides), 'utf8');
  if (env.GITHUB_ENV)
    appendFileSync(env.GITHUB_ENV, `SAM_CONTAINER_IMAGE_OVERRIDES=${JSON.stringify(overrides)}\n`);
  const summary = summaryMarkdown(decisions);
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
