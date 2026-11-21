/**
 * The builds `pnpm selfhost:deploy` runs before `celld deploy`, and the vm-agent publish (split
 * from deploy.ts).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import type { CelldWranglerConfig } from './celld-config.js';
import { commandPath } from './command-path.js';
import { bucketOf, log, REPO_ROOT } from './deploy-steps.js';
import { publishVmAgentArtifacts, removeVmAgentBuild } from './vm-agent-artifacts.js';

const WEB_DIR = join(REPO_ROOT, 'apps/web');

export function buildWeb(baseDomain: string): string {
  log(`building apps/web for https://api.${baseDomain}`);
  const env = { ...process.env, VITE_API_URL: `https://api.${baseDomain}` };
  const result = spawnSync(
    commandPath('pnpm'),
    ['exec', 'turbo', 'run', 'build', '--filter=@simple-agent-manager/web'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    }
  );
  if (result.status !== 0) throw new Error('apps/web build failed');
  return join(WEB_DIR, 'dist');
}

/**
 * celld bundles `apps/api/src` with its own esbuild, which resolves the workspace packages
 * (`shared`, `providers`, `cloud-init`) through their built `dist/` entry points. A fresh
 * checkout has none, so build the API's dependencies (not the API itself) first.
 */
export function buildApiDependencies(): void {
  log("building the API Worker's workspace dependencies");
  const result = spawnSync(
    commandPath('pnpm'),
    ['exec', 'turbo', 'run', 'build', '--filter=@simple-agent-manager/api^...'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error('building the API Worker dependencies failed');
}

/** Publishes the built vm-agent into the fleet bucket, then removes the build. */
export function publishVmAgent(
  config: CelldWranglerConfig,
  celld: string,
  env: NodeJS.ProcessEnv,
  binDir: string,
  release: string,
  redact: (text: string) => string
): void {
  const agentBucket = config.r2_buckets.find((bucket) => bucket.binding === 'R2');
  if (!agentBucket) throw new Error('the Worker has no R2 binding to serve the vm-agent from');
  try {
    publishVmAgentArtifacts({
      celld,
      env,
      fleetBucket: bucketOf(env),
      r2BucketName: agentBucket.bucket_name,
      binDir,
      release,
      redact,
      log,
    });
  } finally {
    removeVmAgentBuild(binDir);
  }
}
