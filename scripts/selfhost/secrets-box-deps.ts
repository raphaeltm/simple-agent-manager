/**
 * The real steps behind `pnpm selfhost:secrets migrate` (secrets-migrate.ts) on a box: the deploy
 * script, docker compose, celld's internal reload and the API health check, and the bucket.
 */
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from './backup-cli';
import { type BoxContext, composeArgs } from './backup-lib';
import { detectKeyCandidates } from './key-platforms';
import { keyAgentPort } from './key-service';
import { knownSecrets, scanDeployVersions } from './plaintext-scan';
import type { MigrateDeps } from './secrets-migrate';
import { preflightSealedSecrets } from './secrets-preflight';
import type { SwitchDeps } from './secrets-switch';

const DEFAULT_AGENT_WAIT_MS = 90_000;
const POLL_MS = 1000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Runs a command with its output on the operator's terminal (deploys print a lot). */
function visible(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
}

async function waitForSealedAgent(port: number): Promise<void> {
  const deadline = Date.now() + DEFAULT_AGENT_WAIT_MS;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    const body = response?.ok ? ((await response.json()) as { sealed?: unknown }) : null;
    // The agent of a sealed box; a legacy one answers `sealed: false`.
    if (body && body.sealed !== false) return;
    if (Date.now() > deadline)
      throw new Error(`the key agent did not come up on 127.0.0.1:${port}`);
    await sleep(POLL_MS);
  }
}

/** The switch's box steps: the migration's deploy and checks, plus an agent restart. */
export function boxSwitchDeps(ctx: BoxContext): SwitchDeps {
  const migrate = boxMigrateDeps(ctx);
  return {
    log: ctx.log,
    detect: detectKeyCandidates,
    restartAgent: async () => {
      visible('docker', composeArgs(ctx, ['up', '-d', '--force-recreate', 'key-agent']));
      await waitForSealedAgent(keyAgentPort(ctx.box));
    },
    deploy: async () => migrate.deploy(false),
    adoptAndCheck: migrate.adoptAndCheck,
  };
}

export function boxMigrateDeps(ctx: BoxContext): MigrateDeps {
  const { box, envFile } = ctx;
  const deployArgs = ['selfhost:deploy', '--env-file', envFile];
  return {
    log: ctx.log,
    init: async () => visible('pnpm', [...deployArgs, '--init']),
    preflight: preflightSealedSecrets,
    startStack: async () => {
      visible('docker', composeArgs(ctx, ['up', '-d', '--build']));
      await waitForSealedAgent(keyAgentPort(box));
    },
    deploy: async (legacy) =>
      visible('pnpm', [...deployArgs, ...(legacy ? ['--key-provider', 'legacy-plaintext'] : [])]),
    adoptAndCheck: async () => {
      const internal = box.CELLD_INTERNAL_PORT || '7001';
      const reload = await fetch(`http://127.0.0.1:${internal}/reload`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
      }).catch((error: unknown) => error);
      if (!(reload instanceof Response) || !reload.ok) {
        const detail = reload instanceof Response ? `HTTP ${reload.status}` : String(reload);
        return { healthy: false, detail: `celld did not adopt the deployment (${detail})` };
      }
      const health = await fetch(`http://127.0.0.1:${box.CELLD_PORT || '8080'}/health`, {
        headers: { host: `api.${box.SAM_DOMAIN ?? ''}`, 'x-forwarded-proto': 'https' },
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => error);
      if (!(health instanceof Response)) return { healthy: false, detail: String(health) };
      if (health.ok) return { healthy: true, detail: 'HTTP 200' };
      const body = (await health.text()).slice(0, 300);
      const code = /"code"\s*:\s*"([A-Z_]+)"/.exec(body)?.[1];
      return { healthy: false, detail: `HTTP ${health.status}${code ? ` ${code}` : ''}` };
    },
    currentVersionSecrets: async () => {
      const versions = scanDeployVersions(ctx, await knownSecrets(box, ctx.stateDir));
      const current = versions.find((v) => v.referencedBy.includes('deploy/current.json'));
      if (!current) throw new Error('deploy/current.json names no version in the bucket');
      return current.secretNames;
    },
  };
}
