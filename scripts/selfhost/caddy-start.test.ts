/**
 * deploy/selfhost/caddy/start.sh, the Caddy entrypoint docker-compose.yml runs, under /bin/sh with
 * a stand-in `caddy` on PATH that records how it was started. Real Caddy and its busybox shell run
 * the same script in live/access-log-keep-warm.live.test.ts.
 *
 * F21 L5: compose takes each port from the shell before the .env, so the deploy's range check can
 * be sidestepped by `CELLD_INTERNAL_PORT=20001 docker compose up`. start.sh sees the ports the
 * stack really runs with and refuses to start Caddy (the only way in for a node) when one lies
 * inside the lease range from gateway.env.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BOX_LISTEN_ADDRESSES, BOX_RESERVED_PORTS } from './box-settings.js';

const START = resolve(import.meta.dirname, '../../deploy/selfhost/caddy/start.sh');
let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'sam-caddy-start-'));
  const fake = join(bin, 'caddy');
  writeFileSync(fake, '#!/bin/sh\necho "caddy $*"\n');
  chmodSync(fake, 0o755);
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

/** The environment compose gives Caddy by default, plus gateway.env's range. */
function composeEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(BOX_RESERVED_PORTS).map(([name, port]) => [
        name,
        BOX_LISTEN_ADDRESSES.includes(name) ? `:${port}` : String(port),
      ])
    ),
    REVERSE_TUNNEL_PORT_RANGE_START: '20000',
    REVERSE_TUNNEL_PORT_RANGE_END: '29999',
    SAM_KEEP_WARM: 'on',
    SAM_KEEP_WARM_INTERVAL: '5s',
    SAM_FRP_LOGIN_RATE_LIMIT_EVENTS: '60',
    SAM_FRP_LOGIN_RATE_LIMIT_WINDOW: '1m',
  };
}

function startSh(env: Record<string, string>): { status: number | null; out: string } {
  const run = spawnSync('/bin/sh', [START], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('caddy/start.sh', () => {
  it('starts Caddy with the box defaults', () => {
    const run = startSh(composeEnv());
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('caddy run --config /etc/caddy/Caddyfile --adapter caddyfile');
  });

  it.each(Object.keys(BOX_RESERVED_PORTS))(
    'refuses to start when %s lies inside the lease range',
    (name) => {
      const run = startSh({ ...composeEnv(), [name]: '20001' });
      expect(run.status).toBe(64);
      expect(run.out).toContain(`${name} (20001) lies inside the reverse-tunnel range 20000-29999`);
      expect(run.out).not.toContain('caddy run');
    }
  );

  // sam-mx's listen address: the port after the last ':' is checked, with or without a host.
  it.each([':20001', '0.0.0.0:20001', '[::]:20001'])(
    'refuses SAM_MX_LISTEN=%s inside the lease range',
    (listen) => {
      const run = startSh({ ...composeEnv(), SAM_MX_LISTEN: listen });
      expect(run.status).toBe(64);
      expect(run.out).toContain('SAM_MX_LISTEN (20001) lies inside the reverse-tunnel range');
    }
  );

  // A malformed bound used to make `[ -ge ]` error, which `if` reads as false: the range check
  // was skipped and Caddy started with a box port inside the real range.
  it.each([
    { REVERSE_TUNNEL_PORT_RANGE_START: '1:2' },
    { REVERSE_TUNNEL_PORT_RANGE_END: '29999:1' },
    { REVERSE_TUNNEL_PORT_RANGE_START: '20000x' },
    { REVERSE_TUNNEL_PORT_RANGE_END: ' 29999' },
  ])('refuses a malformed lease range %j instead of skipping the check', (bad) => {
    const run = startSh({ ...composeEnv(), CELLD_INTERNAL_PORT: '20001', ...bad });
    expect(run.status).toBe(64);
    expect(run.out).toMatch(/RANGE_START\/END missing from gateway.env or not a number/);
    expect(run.out).not.toContain('caddy run');
  });

  it('accepts the range edges just outside a port (control)', () => {
    const run = startSh({
      ...composeEnv(),
      REVERSE_TUNNEL_PORT_RANGE_START: '7002',
      REVERSE_TUNNEL_PORT_RANGE_END: '7999',
    });
    expect(run.status, run.out).toBe(0);
  });

  it.each([
    [{ REVERSE_TUNNEL_PORT_RANGE_START: '' }, /RANGE_START\/END missing from gateway.env/],
    [{ CELLD_INTERNAL_PORT: '' }, /CELLD_INTERNAL_PORT must be set to a port number/],
    [{ SAM_FRP_LOGIN_RATE_LIMIT_EVENTS: '0' }, /SAM_FRP_LOGIN_RATE_LIMIT_EVENTS must be/],
    [{ SAM_FRP_LOGIN_RATE_LIMIT_EVENTS: '6x' }, /SAM_FRP_LOGIN_RATE_LIMIT_EVENTS must be/],
    [{ SAM_FRP_LOGIN_RATE_LIMIT_WINDOW: '2d' }, /SAM_FRP_LOGIN_RATE_LIMIT_WINDOW must be/],
    [{ SAM_KEEP_WARM_INTERVAL: '9s' }, /SAM_KEEP_WARM_INTERVAL must be 1s to 6s/],
  ])('refuses %j', (override, message) => {
    const run = startSh({ ...composeEnv(), ...override });
    expect(run.status).toBe(64);
    expect(run.out).toMatch(message);
  });
});
