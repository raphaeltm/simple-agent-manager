import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as TOML from '@iarna/toml';

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_PREBUILT_DOWNLOAD_TIMEOUT_MS,
  type EngineRunner,
  type InstallerEngineConfig,
} from './installer-engine-contract.js';
import {
  fetchPrebuiltManifest,
  importPrebuiltImages,
  placePrebuiltFiles,
  prebuiltBaseUrl,
} from './installer-engine-prebuilt.js';

/**
 * The engine's optional prebuilt fast path (installer-engine-prebuilt.ts) bound to
 * one run. Legacy CI always builds. Every miss or failure resolves to "build".
 */
export function prebuiltSteps(input: {
  config: InstallerEngineConfig;
  runner: EngineRunner;
  root: string;
  env: NodeJS.ProcessEnv;
  prefix: string;
  stack: string;
}) {
  const { config: c, runner, root, env } = input;
  const base = c.profile === 'legacy-ci' ? undefined : prebuiltBaseUrl(env.SAM_ARTIFACT_BASE_URL);
  const timeoutMs = Number(
    env.INSTALLER_PREBUILT_DOWNLOAD_TIMEOUT_MS ?? DEFAULT_PREBUILT_DOWNLOAD_TIMEOUT_MS
  );
  const commandTimeoutMs = c.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const manifest = base ? fetchPrebuiltManifest(runner.request, base) : Promise.resolve(undefined);

  /** Place the published files of `kind` for `key`; false means build them. */
  const files = async (kind: string, key: string, paths: readonly string[]) => {
    const published = await manifest;
    return (
      !!published &&
      !!base &&
      placePrebuiltFiles({
        request: runner.request,
        base,
        manifest: published,
        kind,
        key,
        root,
        paths,
        timeoutMs,
      })
    );
  };

  /**
   * Digest-pinned account references by container class for every usable
   * published image. Image keys cover the VM-agent outputs, so this waits for
   * `agentOutputs`. Classes left out are built by Wrangler.
   */
  const images = (agentOutputs: Promise<unknown>): Promise<Record<string, string>> =>
    (async () => {
      const published = await manifest;
      if (!published?.images.length || !base) return {};
      await agentOutputs;
      const topLevel = TOML.parse(readFileSync(join(root, 'apps/api/wrangler.toml'), 'utf8')) as {
        containers?: { class_name: string; image: string }[];
      };
      return importPrebuiltImages({
        request: runner.request,
        base,
        manifest: published,
        accountId: c.accountId,
        contextDir: join(root, 'apps/api'),
        containers: (topLevel.containers ?? []).map((container) => ({
          className: container.class_name,
          dockerfile: container.image.replace(/^\.\//, ''),
        })),
        repository: (className) =>
          `${input.prefix}-api-${input.stack}-${className.toLowerCase()}-prebuilt`,
        work: join(root, '.wrangler', 'installer-engine', 'images'),
        timeoutMs,
        run: (executable, args, extra) =>
          runner.run(
            { executable, args },
            {
              cwd: root,
              env: { ...env, ...extra },
              timeoutMs: commandTimeoutMs,
              discardOutput: executable === 'tar',
            }
          ),
        registryPassword: async () => {
          // The output is the password itself, so a failure must not report it
          // (EngineRunOptions.privateOutput).
          const output = await runner.run(
            {
              executable: 'pnpm',
              args: [
                '--filter',
                '@simple-agent-manager/api',
                'exec',
                'wrangler',
                'containers',
                'registries',
                'credentials',
                'registry.cloudflare.com',
                '--push',
                '--pull',
                '--json',
              ],
            },
            { cwd: root, env, timeoutMs: commandTimeoutMs, privateOutput: true }
          );
          const parsed: unknown = JSON.parse(output.slice(output.indexOf('{')));
          const password =
            parsed && typeof parsed === 'object' && 'password' in parsed
              ? parsed.password
              : undefined;
          if (typeof password !== 'string' || !password)
            throw new Error('Registry credentials missing');
          return password;
        },
      });
    })().catch(() => ({}));

  return { files, images };
}
