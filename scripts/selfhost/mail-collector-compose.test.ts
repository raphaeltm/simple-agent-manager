/**
 * The mail collector shows every sign-in code, so its exposure in docker-compose.yml is pinned:
 * off by default (its own profile), loopback listeners only, no published ports, its own UI
 * authentication required, a digest-pinned image, and Caddy started through start.sh (which
 * refuses to serve the collector without its password).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Service {
  profiles?: string[];
  image?: string;
  command?: string[];
  ports?: unknown[];
  network_mode?: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  entrypoint?: string[];
  env_file?: Array<{ path: string; required: boolean }>;
}

const compose = parse(
  readFileSync(resolve(import.meta.dirname, '../../deploy/selfhost/docker-compose.yml'), 'utf8')
) as { services: Record<string, Service> };
const collector = compose.services['mail-collector'];
const caddy = compose.services.caddy;

function flagValue(command: string[], flag: string): string | undefined {
  const at = command.indexOf(flag);
  return at >= 0 ? command[at + 1] : undefined;
}

describe('mail-collector compose service', () => {
  it('exists only behind its own profile', () => {
    expect(collector?.profiles).toEqual(['mail-collector']);
  });

  it('listens on loopback only and publishes no ports', () => {
    const command = collector?.command ?? [];
    expect(flagValue(command, '--smtp')).toMatch(/^127\.0\.0\.1:/);
    expect(flagValue(command, '--listen')).toMatch(/^127\.0\.0\.1:/);
    expect(collector?.ports).toBeUndefined();
  });

  it('requires its own UI authentication file, and refuses to start without it', () => {
    expect(collector?.env_file).toEqual([
      { path: '${SAM_SELFHOST_STATE_DIR:-./.state}/mail-collector-ui.env', required: true },
    ]);
  });

  it('runs unprivileged from a digest-pinned image', () => {
    expect(collector?.image).toMatch(/^axllent\/mailpit:v[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(collector?.user).toBe('65534:65534');
    expect(collector?.read_only).toBe(true);
    expect(collector?.cap_drop).toEqual(['ALL']);
  });

  it('starts Caddy through start.sh with the collector switch file', () => {
    expect(caddy?.entrypoint).toEqual(['/bin/sh', '/etc/caddy/start.sh']);
    expect(caddy?.env_file).toContainEqual({
      path: '${SAM_SELFHOST_STATE_DIR:-./.state}/mail-collector.env',
      required: false,
    });
  });
});
