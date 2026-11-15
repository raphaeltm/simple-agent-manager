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
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as TOML from '@iarna/toml';

import { fingerprintInputs, type FingerprintIo, jsonObject } from './container-image-fingerprints';
import {
  analyzeDockerfile,
  composeImageKey,
  type InputFingerprints,
} from './container-image-inputs';
import { ACCOUNT_IMAGE_REFERENCE } from './installer-engine-prebuilt';
import { containerImageOverrides } from './sync-wrangler-config';
import { containerApplicationNames } from './wait-container-rollout';

/** Flags Wrangler 4.x passes to `docker build`; part of the key. */
export const BUILD_FLAGS = ['--platform', 'linux/amd64', '--provenance=false'] as const;
export const DEFAULT_FINGERPRINT_TIMEOUT_MS = 180_000;
export const DEFAULT_REGISTRY_CREDENTIAL_MINUTES = 30;
const REGISTRY = 'registry.cloudflare.com';

export interface ContainerTarget {
  className: string;
  /** Dockerfile path relative to the build context. */
  dockerfile: string;
  /** Registry repository Wrangler deploys this class from. */
  repository: string;
}

export type Outcome = 'reused' | 'built' | 'rebuild-by-wrangler';

export interface Decision {
  className: string;
  key: string | null;
  outcome: Outcome;
  reason: string;
  reference: string | null;
  seconds: number;
}

/** A failed `docker build`. Wrangler's build of the same Dockerfile would fail too. */
export class ImageBuildError extends Error {}

export interface RegistryIo {
  /** Digest of `<repository>:<tag>`, null when the tag does not exist. Throws on doubt. */
  lookup(repository: string, tag: string): Promise<string | null>;
  /** Build the Dockerfile, push it as `<repository>:<tag>`, return the pushed digest. */
  buildAndPush(target: ContainerTarget, repository: string, tag: string): Promise<string>;
}

export interface ResolveDeps {
  accountId: string;
  contextDir: string;
  registry: RegistryIo;
  fingerprint(dockerfile: string): Promise<InputFingerprints>;
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
  let existing: string | null;
  try {
    existing = await deps.registry.lookup(repository, tag);
    if (existing) return decide('reused', 'inputs unchanged', key, reference(existing));
  } catch (error) {
    return rebuild(`registry lookup failed: ${message(error)}`, key);
  }
  try {
    const digest = await deps.registry.buildAndPush(target, repository, tag);
    return decide('built', 'no image for these inputs', key, reference(digest));
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

export function summaryMarkdown(decisions: Decision[]): string {
  const rows = decisions.map(
    (d) =>
      `| ${d.className} | ${d.outcome} | ${d.reason.replaceAll('|', '/')} | ${d.key ? d.key.slice(0, 16) : '-'} | ${d.reference ? d.reference.split('@')[1].slice(0, 19) : '-'} | ${d.seconds}s |`
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

// ---------------------------------------------------------------------------
// Process boundary
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; echo?: boolean } = {}
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

async function runChecked(
  command: string,
  args: string[],
  options: Parameters<typeof runProcess>[2] = {}
): Promise<string> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0)
    throw new Error(
      `${command} ${args[0] ?? ''} exited ${result.code}: ${result.stderr.trim().slice(-400)}`
    );
  return result.stdout;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function fetchIo(timeoutMs: number): FingerprintIo {
  return {
    async fetchBytes(url) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    run: (command, args, options) => runChecked(command, args, options),
  };
}

function dockerRegistry(input: {
  root: string;
  contextDir: string;
  credentialMinutes: number;
}): RegistryIo & { dispose(): void } {
  const configDir = mkdtempSync(join(tmpdir(), 'sam-registry-'));
  // A fresh short-lived credential per use: a build can outlast one.
  const login = async () => {
    const output = await runChecked(
      'pnpm',
      [
        '--filter',
        '@simple-agent-manager/api',
        'exec',
        'wrangler',
        'containers',
        'registries',
        'credentials',
        REGISTRY,
        '--push',
        '--pull',
        '--json',
        '--expiration-minutes',
        String(input.credentialMinutes),
      ],
      { cwd: input.root }
    ).catch(() => {
      // The output may contain the password; never echo it.
      throw new Error('Could not obtain registry credentials');
    });
    const parsed = jsonObject(output.slice(output.indexOf('{')), 'registry credentials');
    if (typeof parsed.password !== 'string' || !parsed.password)
      throw new Error('Registry credentials missing');
    const username =
      typeof parsed.username === 'string' && parsed.username ? parsed.username : 'v1';
    const auth = Buffer.from(`${username}:${parsed.password}`).toString('base64');
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ auths: { [REGISTRY]: { auth } } }),
      {
        mode: 0o600,
      }
    );
    return { DOCKER_CONFIG: configDir };
  };
  return {
    async lookup(repository, tag) {
      const env = await login();
      const result = await runProcess(
        'docker',
        ['manifest', 'inspect', '-v', `${repository}:${tag}`],
        {
          env,
        }
      );
      if (result.code !== 0) {
        if (/no such manifest|manifest unknown|name unknown|not found/i.test(result.stderr)) return null;
        throw new Error(
          `docker manifest inspect exited ${result.code}: ${result.stderr.trim().slice(-300)}`
        );
      }
      const descriptor = jsonObject(result.stdout, 'registry manifest').Descriptor;
      const digest =
        descriptor && typeof descriptor === 'object'
          ? (descriptor as Record<string, unknown>).digest
          : undefined;
      if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error('Registry returned no single-image digest');
      return digest;
    },
    async buildAndPush(target, repository, tag) {
      const image = `${repository}:${tag}`;
      try {
        await runChecked(
          'docker',
          [
            'build',
            '--load',
            '-t',
            image,
            ...BUILD_FLAGS,
            '-f',
            join(input.contextDir, target.dockerfile),
            input.contextDir,
          ],
          { echo: true }
        );
      } catch (error) {
        throw new ImageBuildError(message(error));
      }
      const env = await login();
      await runChecked('docker', ['push', image], { env, echo: true });
      const digests = JSON.parse(
        await runChecked('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', image])
      ) as unknown;
      const digest = Array.isArray(digests)
        ? digests
            .filter((value): value is string => typeof value === 'string')
            .find((value) => value.startsWith(`${repository}@`))
            ?.split('@')[1]
        : undefined;
      if (!digest) throw new Error(`No pushed digest for ${image}`);
      return digest;
    },
    dispose: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

async function main() {
  const env = process.env;
  const root = resolve(import.meta.dirname, '../..');
  const contextDir = join(root, 'apps/api');
  const tomlPath = join(contextDir, 'wrangler.toml');
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const worker = env.API_WORKER_NAME;
  const environment = env.DEPLOY_ENV;
  if (!accountId || !env.CLOUDFLARE_API_TOKEN || !worker || !environment)
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
      DEFAULT_REGISTRY_CREDENTIAL_MINUTES
    ),
  });
  const deps: ResolveDeps = {
    accountId,
    contextDir,
    registry,
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
