/**
 * Process and network boundary of `container-image-reuse.ts`: Docker and
 * Wrangler commands, registry credentials, and fingerprint I/O. Decision logic
 * lives in `container-image-reuse.ts` and is tested without these.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FingerprintIo, jsonObject } from './container-image-fingerprints';

/** Flags Wrangler 4.x passes to `docker build`; part of the key. */
export const BUILD_FLAGS = ['--platform', 'linux/amd64', '--provenance=false'] as const;

export const REGISTRY = 'registry.cloudflare.com';

export interface ContainerTarget {
  className: string;
  /** Dockerfile path relative to the build context. */
  dockerfile: string;
  /** Registry repository Wrangler deploys this class from. */
  repository: string;
}

/** A failed `docker build`. Wrangler's build of the same Dockerfile would fail too. */
export class ImageBuildError extends Error {}

export interface RegistryIo {
  /** Digest of `<repository>:<tag>`, null when the tag does not exist. Throws on doubt. */
  lookup(repository: string, tag: string): Promise<string | null>;
  /** Build the Dockerfile, push it as `<repository>:<tag>`, return the pushed digest. */
  buildAndPush(target: ContainerTarget, repository: string, tag: string): Promise<string>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    echo?: boolean;
    /** Run without the deploy's secrets (registry resolvers can execute upstream code). */
    isolated?: boolean;
  } = {}
): Promise<RunResult> {
  const base = options.isolated
    ? Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'LANG']
          .filter((name) => process.env[name] !== undefined)
          .map((name) => [name, process.env[name]])
      )
    : process.env;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...base, ...options.env },
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

export async function runChecked(
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

export function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error(`${name} must be a positive integer no greater than ${max}`);
  return value;
}

export function fetchIo(timeoutMs: number): FingerprintIo {
  return {
    async fetchBytes(url) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    run: (command, args, options) => runChecked(command, args, { ...options, isolated: true }),
  };
}

export function dockerRegistry(input: {
  root: string;
  contextDir: string;
  credentialMinutes: number;
}): RegistryIo & { dispose(): void } {
  const configDir = mkdtempSync(join(tmpdir(), 'sam-registry-'));
  // A fresh short-lived credential per use: a build can outlast one. Lookups get
  // pull-only credentials; only the push after a build may write.
  const login = async (permissions: ('--push' | '--pull')[]) => {
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
        ...permissions,
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
      const env = await login(['--pull']);
      const result = await runProcess(
        'docker',
        ['manifest', 'inspect', '-v', `${repository}:${tag}`],
        {
          env,
        }
      );
      if (result.code !== 0) {
        if (/no such manifest|manifest unknown|name unknown|not found/i.test(result.stderr))
          return null;
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
      const env = await login(['--push', '--pull']);
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
