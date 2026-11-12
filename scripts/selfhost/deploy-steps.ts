/**
 * Small steps of `pnpm selfhost:deploy` (deploy.ts), kept apart so the orchestration stays short.
 */
import { existsSync, readFileSync } from 'node:fs';

import { gatewayEnvAction } from './box-settings.js';
import type { CelldWranglerConfig } from './celld-config.js';
import { writePrivateFile } from './secret-files.js';

function log(message: string): void {
  console.log(`[selfhost] ${message}`);
}

export function redact(config: CelldWranglerConfig, secretNames: Set<string>): CelldWranglerConfig {
  const vars = Object.fromEntries(
    Object.entries(config.vars).map(([key, value]) => [
      key,
      secretNames.has(key) ? '<redacted>' : value,
    ])
  );
  return { ...config, vars };
}

/**
 * Write gateway.env (frps and Caddy read it via env_file) when it changed. Outside `--init` a
 * change stops the deploy before the Worker is updated: frps reads the file only when it starts,
 * so the Worker must not assume a heartbeat timeout or range the running frps is not enforcing.
 */
export function syncGatewayEnv(path: string, content: string, init: boolean): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const action = gatewayEnvAction(existing, content, init);
  if (action === 'unchanged') return;
  writePrivateFile(path, content);
  log(`wrote ${path}; (re)start the stack: docker compose up -d`);
  if (action === 'write-then-restart') {
    throw new Error(
      `${path} changed. Restart frps and Caddy so they run it (docker compose up -d), ` +
        'then run pnpm selfhost:deploy again; the Worker is not updated before they agree.'
    );
  }
}
