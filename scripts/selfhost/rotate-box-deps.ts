/**
 * The real steps behind `pnpm selfhost:secrets rotate` on a box (rotate-run.ts): the deploy and
 * celld adoption of `secrets migrate`, a backup, docker compose for the gateway consumers, and
 * loopback requests to celld (the key-rotation control endpoint is never reached through Caddy).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  KEY_ROTATION_AUTH_HEADER,
  KEY_ROTATION_PATH,
  signKeyRotationRequest,
} from '../../apps/api/src/selfhost/key-rotation/control-auth.ts';
import { gitCommit, REPO_ROOT, SELFHOST_DIR } from './backup-cli';
import { type BoxContext, composeArgs, runBackup } from './backup-lib';
import type { RotateDeps } from './rotate-apply';
import { boxMigrateDeps } from './secrets-box-deps';

/** Per control request; a page is bounded at 10 s on the Worker side (control.ts). */
const DEFAULT_CONTROL_TIMEOUT_MS = 60_000;
/** Services that read gateway.env (docker-compose.yml `env_file`). */
const GATEWAY_CONSUMERS = ['caddy', 'frps', 'sam-mx'] as const;

function celld(ctx: BoxContext, path: string): string {
  return `http://127.0.0.1:${ctx.box.CELLD_PORT || '8080'}${path}`;
}

function apiHeaders(ctx: BoxContext): Record<string, string> {
  return { host: `api.${ctx.box.SAM_DOMAIN ?? ''}`, 'x-forwarded-proto': 'https' };
}

function runningServices(ctx: BoxContext): string[] {
  const result = spawnSync(
    'docker',
    composeArgs(ctx, ['ps', '--services', '--status', 'running']),
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) throw new Error(`docker compose ps failed (exit ${result.status})`);
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function boxRotateDeps(ctx: BoxContext): RotateDeps {
  const migrate = boxMigrateDeps(ctx);
  return {
    log: ctx.log,
    now: () => Date.now(),
    backup: () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = join(SELFHOST_DIR, 'backups', `pre-rotate-${stamp}`);
      runBackup(ctx, dir, gitCommit());
      return dir;
    },
    deploy: async () => await migrate.deploy(false),
    adoptAndCheck: migrate.adoptAndCheck,
    restartGatewayConsumers: async () => {
      const running = runningServices(ctx);
      const services = GATEWAY_CONSUMERS.filter((name) => running.includes(name));
      const result = spawnSync(
        'docker',
        composeArgs(ctx, ['up', '-d', '--force-recreate', '--no-deps', ...services]),
        { cwd: REPO_ROOT, stdio: 'inherit' }
      );
      if (result.status !== 0) throw new Error(`docker compose up failed (exit ${result.status})`);
    },
    control: async (controlKey, body) => {
      const text = JSON.stringify(body);
      const response = await fetch(celld(ctx, KEY_ROTATION_PATH), {
        method: 'POST',
        headers: {
          ...apiHeaders(ctx),
          'content-type': 'application/json',
          [KEY_ROTATION_AUTH_HEADER]: await signKeyRotationRequest(controlKey, text),
        },
        body: text,
        signal: AbortSignal.timeout(DEFAULT_CONTROL_TIMEOUT_MS),
      });
      const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        throw new Error(
          `key-rotation endpoint answered HTTP ${response.status} ${typeof answer?.error === 'string' ? answer.error : ''}`.trim()
        );
      }
      return answer;
    },
    getJson: async (path) => {
      const response = await fetch(celld(ctx, path), {
        headers: apiHeaders(ctx),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    probeGateway: async (secret) => {
      // frps's plugin call shape (deploy/selfhost/frps/frps.toml); an empty body is refused
      // with a 200 verdict after authentication, a wrong secret with 401 before it.
      const response = await fetch(celld(ctx, '/api/self-host/gateway/frps-plugin?op=Ping'), {
        method: 'POST',
        headers: {
          ...apiHeaders(ctx),
          authorization: `Basic ${Buffer.from(`frps:${secret}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer().catch(() => undefined);
      return response.status;
    },
  };
}
