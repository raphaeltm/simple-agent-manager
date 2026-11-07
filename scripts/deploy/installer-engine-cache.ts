import { join } from 'node:path';

// @ts-expect-error Shared JavaScript cache helpers have no declaration file.
import * as buildCache from './installer-build-cache.mjs';
import type { BuildCacheStore, EngineOptions } from './installer-engine-contract.js';

export const VM_AGENT_OUTPUTS = buildCache.VM_AGENT_OUTPUTS as string[];
export const CLI_OUTPUTS = buildCache.CLI_OUTPUTS as string[];
export type CachedBuild = (
  kind: string,
  inputs: Record<string, string>,
  files: string[],
  sourcePath: string,
  build: () => Promise<unknown>
) => Promise<void>;

/** Open the installation build cache in the state bucket, offer the restored source
 * bundle to later installations, and return the cache-or-build step. Without a
 * store (legacy CI, or a cache that cannot open) every step simply builds. */
export async function openEngineBuildCache(input: {
  options: EngineOptions;
  enabled: boolean;
  accountId: string;
  bucket: string;
  root: string;
  sourceCommit: string;
  /** This installation's private Pulumi passphrase; only an HMAC key derives from it. */
  passphrase: string | undefined;
  git(args: string[]): Promise<string>;
}): Promise<CachedBuild> {
  const work = join(input.root, '.wrangler', 'installer-engine', 'cache');
  let store: BuildCacheStore | undefined;
  let authKey: Buffer | undefined;
  try {
    // Binary outputs are authenticated with this installation's own secret, so
    // another installation's (or a leaked old credential's) entries are a miss.
    if (input.enabled) authKey = buildCache.cacheAuthKey(input.passphrase) as Buffer;
    if (authKey)
      store = input.options.buildCache?.({
        accountId: input.accountId,
        bucket: input.bucket,
        work,
      });
  } catch {
    store = undefined;
  }
  // The source bundle needs no MAC: the restore re-verifies the approved commit itself.
  await buildCache.publishSourceBundle({
    store,
    root: input.root,
    commit: input.sourceCommit,
  });
  return async (kind, inputs, files, sourcePath, build) => {
    // A dirty input tree is never cached: the key would not describe what was built.
    const clean =
      store !== undefined &&
      (await input.git(['status', '--porcelain', '--', sourcePath])).trim() === '';
    await buildCache.cachedOutputs({
      store: clean ? store : undefined,
      authKey,
      key: buildCache.cacheKey(kind, inputs),
      root: input.root,
      files,
      work,
      build,
    });
  };
}
