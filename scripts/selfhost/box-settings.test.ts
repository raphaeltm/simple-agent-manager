import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  BOX_LISTEN_ADDRESSES,
  BOX_RESERVED_PORTS,
  celldChildEnv,
  gatewayEnvAction,
  loadBoxEnv,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelPortRange,
  resolveTunnelSettings,
  trimSlashes,
  tunnelWorkerVars,
  withComposeShellOverrides,
} from './box-settings.js';
import { composeFileVariables, composeVariableNames } from './compose-env.js';
import { SELFHOST_DIR, syncGatewayEnv } from './deploy-steps.js';
import { parseDotenv } from './secret-files.js';

const SECRET = 'ab'.repeat(32);

describe('tunnel port range', () => {
  it('defaults, and gives the Worker and frps the same values', () => {
    const settings = resolveTunnelSettings({});
    expect(settings).toEqual({
      range: { start: 20000, end: 29999 },
      heartbeatTimeoutSeconds: 90,
      portReuseMinAgeSeconds: null,
    });
    const frps = parseDotenv(renderGatewayEnv(SECRET, settings), 'gateway.env');
    const worker = tunnelWorkerVars(settings);
    for (const name of [
      'REVERSE_TUNNEL_PORT_RANGE_START',
      'REVERSE_TUNNEL_PORT_RANGE_END',
      'REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS',
    ]) {
      expect(frps[name], name).toBeDefined();
      expect(frps[name], name).toBe(worker[name]);
    }
    expect(frps.REVERSE_TUNNEL_GATEWAY_SECRET).toBe(SECRET);
    expect(worker.REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS).toBeUndefined();
  });

  it('takes the box override and rejects bad ranges', () => {
    const box = {
      REVERSE_TUNNEL_PORT_RANGE_START: '30000',
      REVERSE_TUNNEL_PORT_RANGE_END: '30099',
    };
    expect(resolveTunnelPortRange(box)).toEqual({ start: 30000, end: 30099 });
    expect(() => resolveTunnelPortRange({ REVERSE_TUNNEL_PORT_RANGE_START: '80' })).toThrow(/1024/);
    expect(() =>
      resolveTunnelPortRange({
        REVERSE_TUNNEL_PORT_RANGE_START: '25000',
        REVERSE_TUNNEL_PORT_RANGE_END: '24000',
      })
    ).toThrow(/above/);
  });

  it('enforces the same size cap as the Worker', () => {
    const at = { REVERSE_TUNNEL_PORT_RANGE_START: '10000', REVERSE_TUNNEL_PORT_RANGE_END: '29999' };
    expect(resolveTunnelPortRange(at)).toEqual({ start: 10000, end: 29999 });
    expect(() =>
      resolveTunnelPortRange({ ...at, REVERSE_TUNNEL_PORT_RANGE_START: '9999' })
    ).toThrow(/at most 20000 ports/);
  });

  // Each box listener at its compose default, then moved into an otherwise valid range.
  it.each(Object.entries(BOX_RESERVED_PORTS))(
    'fails the deploy when the range contains %s',
    (name, fallback) => {
      if (fallback >= 1024) {
        expect(() =>
          resolveTunnelPortRange({
            REVERSE_TUNNEL_PORT_RANGE_START: String(fallback),
            REVERSE_TUNNEL_PORT_RANGE_END: String(fallback),
          })
        ).toThrow(new RegExp(`contains ${name} \\(${fallback}\\)`));
      }
      expect(() => resolveTunnelPortRange({ [name]: '20500' })).toThrow(
        new RegExp(`contains ${name} \\(20500\\)`)
      );
      // Control: the same listener moved just outside the range is accepted.
      expect(resolveTunnelPortRange({ [name]: '30000' })).toEqual({ start: 20000, end: 29999 });
    }
  );

  it('derives the reuse age floor from the heartbeat timeout frps gets', () => {
    expect(
      resolveTunnelSettings({ REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '120' })
    ).toMatchObject({ heartbeatTimeoutSeconds: 120, portReuseMinAgeSeconds: null });
    expect(() => resolveTunnelSettings({ REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '30' })).toThrow(
      /between 60 and 3600/
    );
    const longer = resolveTunnelSettings({ REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: '600' });
    expect(tunnelWorkerVars(longer).REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS).toBe('600');
    expect(() =>
      resolveTunnelSettings({
        REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '120',
        REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: '200',
      })
    ).toThrow(/between 240 and/);
  });

  it('refuses a gateway secret that is not 32 bytes of hex', () => {
    expect(() => renderGatewayEnv('short', resolveTunnelSettings({}))).toThrow(/32 bytes/);
  });
});

describe('celldChildEnv', () => {
  it('passes only allowlisted host vars plus storage settings', () => {
    const env = celldChildEnv(
      { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'leak', AWS_ACCESS_KEY_ID: 'host-key' },
      { CELLD_BUCKET: 's3://b', AWS_ACCESS_KEY_ID: 'box-key', SAM_DOMAIN: 'x.example' },
      '/esbuild'
    );
    expect(env).toEqual({
      CELLD_ESBUILD: '/esbuild',
      PATH: '/bin',
      HOME: '/h',
      CELLD_BUCKET: 's3://b',
      AWS_ACCESS_KEY_ID: 'box-key',
    });
  });

  it('does not inherit host storage credentials the box did not set (gs:// uses ADC)', () => {
    const env = celldChildEnv({ AWS_SECRET_ACCESS_KEY: 'host' }, { CELLD_BUCKET: 'gs://b' }, '/e');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('removes secret values, including each line of a PEM, but not short flags', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const out = redactSecrets(`key=${SECRET} pem=${pem} flag=true`, [SECRET, pem, 'true']);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(out).toContain('flag=true');
  });
});

describe('presignVars', () => {
  it('derives the fleet bucket and the R2 key prefix celld uses', () => {
    expect(presignVars({ CELLD_BUCKET: 's3://celld-fleet' }, 'assets')).toEqual({
      R2_S3_BUCKET: 'celld-fleet',
      R2_S3_KEY_PREFIX: 'r2/assets/',
    });
    expect(
      presignVars(
        { CELLD_BUCKET: 'gs://my-bucket/celld/', R2_S3_ENDPOINT: 'https://storage.googleapis.com' },
        'assets'
      )
    ).toEqual({
      R2_S3_BUCKET: 'my-bucket',
      R2_S3_KEY_PREFIX: 'celld/r2/assets/',
      R2_S3_ENDPOINT: 'https://storage.googleapis.com',
      // The Worker refuses an operator store without a region; GCS signs with "auto".
      R2_S3_REGION: 'auto',
    });
  });

  // The Worker side (main's resolveR2PresignConfig) is exercised against these vars in
  // apps/api/tests/unit/selfhost/presign-vars-resolver.test.ts; importing the Worker's env types
  // here would pull the whole API into this package's typecheck.
  it('passes an explicit region through and requires one for an s3:// store', () => {
    expect(
      presignVars(
        {
          CELLD_BUCKET: 's3://celld-fleet',
          R2_S3_ENDPOINT: 'https://s3.example.com',
          R2_S3_REGION: 'us-east-1',
        },
        'assets'
      ).R2_S3_REGION
    ).toBe('us-east-1');
    expect(() =>
      presignVars(
        { CELLD_BUCKET: 's3://celld-fleet', R2_S3_ENDPOINT: 'https://s3.example.com' },
        'assets'
      )
    ).toThrow(/R2_S3_REGION is required/);
  });

  it('gives Azure buckets no presign vars', () => {
    expect(presignVars({ CELLD_BUCKET: 'az://container' }, 'assets')).toEqual({});
  });

  it('trims slashes around the fleet prefix but keeps inner ones', () => {
    const keyPrefix = (bucket: string) =>
      presignVars({ CELLD_BUCKET: bucket }, 'assets').R2_S3_KEY_PREFIX;
    expect(keyPrefix('s3://b')).toBe('r2/assets/');
    expect(keyPrefix('s3://b/')).toBe('r2/assets/');
    expect(keyPrefix('s3://b///')).toBe('r2/assets/');
    expect(keyPrefix('s3://b//a/b//')).toBe('a/b/r2/assets/');
    expect(keyPrefix('b/a//c')).toBe('a//c/r2/assets/');
    expect(trimSlashes('')).toBe('');
    expect(trimSlashes('/')).toBe('');
    expect(trimSlashes('//x//')).toBe('x');
  });

  it('trims a long run of inner slashes in linear time (regression: /\\/+$/ was quadratic)', () => {
    // The previous /^\/+|\/+$/g took ~1.2 s on 40k inner slashes; linear trimming takes <1 ms.
    const bucket = `s3://b/a${'/'.repeat(50_000)}x/`;
    const started = performance.now();
    const vars = presignVars({ CELLD_BUCKET: bucket }, 'assets');
    expect(performance.now() - started).toBeLessThan(200);
    expect(vars.R2_S3_KEY_PREFIX).toBe(`a${'/'.repeat(50_000)}x/r2/assets/`);
  });
});

const COMPOSE_TEXT = readFileSync(
  join(import.meta.dirname, '../../deploy/selfhost/docker-compose.yml'),
  'utf8'
);

describe('BOX_RESERVED_PORTS', () => {
  it('matches the defaults docker-compose.yml actually uses', () => {
    // A listen address (SAM_MX_LISTEN) defaults to `:<port>`.
    const defaults = [...COMPOSE_TEXT.matchAll(/\$\{([A-Z_]+):-:?(\d+)\}/g)].map(
      (m) => [m[1]!, Number(m[2])] as const
    );
    for (const [name, port] of Object.entries(BOX_RESERVED_PORTS)) {
      const used = defaults.filter(([found]) => found === name).map(([, value]) => value);
      expect(used.length, name).toBeGreaterThan(0);
      // Every interpolation of the port in the file falls back to the same default.
      expect(new Set(used), name).toEqual(new Set([port]));
    }
  });

  // F21 L5: caddy/start.sh can only check the ports compose passes it.
  it('are all passed to Caddy, whose start.sh refuses any inside the lease range', () => {
    const compose = parse(COMPOSE_TEXT) as {
      services: { caddy: { environment: Record<string, string> } };
    };
    const startSh = readFileSync(
      join(import.meta.dirname, '../../deploy/selfhost/caddy/start.sh'),
      'utf8'
    );
    for (const [name, port] of Object.entries(BOX_RESERVED_PORTS)) {
      const fallback = BOX_LISTEN_ADDRESSES.includes(name) ? `:${port}` : String(port);
      expect(compose.services.caddy.environment[name], name).toBe(`\${${name}:-${fallback}}`);
      expect(startSh, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

// Compose takes every variable it interpolates from the shell before --env-file, so the deploy and
// upgrade must too: a shell CELLD_BUCKET or SAM_DOMAIN would otherwise make the deploy publish with
// the .env value while celld and Caddy run with the shell's.
describe('withComposeShellOverrides (F21 L5)', () => {
  const composeNames = composeFileVariables({}, SELFHOST_DIR);

  it('applies a shell override of any compose variable, as docker compose does, and reports it', () => {
    const { box, overridden } = withComposeShellOverrides(
      { CELLD_BUCKET: 'gs://fleet/celld', SAM_DOMAIN: 'box.example', CELLD_INTERNAL_PORT: '7001' },
      {
        CELLD_BUCKET: 'gs://other/celld',
        SAM_DOMAIN: 'other.example',
        CELLD_INTERNAL_PORT: '7001',
      },
      composeNames
    );
    expect(overridden).toEqual(['CELLD_BUCKET', 'SAM_DOMAIN']);
    expect(box).toEqual({
      CELLD_BUCKET: 'gs://other/celld',
      SAM_DOMAIN: 'other.example',
      CELLD_INTERNAL_PORT: '7001',
    });
  });

  it('applies a shell port override, so the range check sees the port compose will bind', () => {
    const { box, overridden } = withComposeShellOverrides(
      { CELLD_INTERNAL_PORT: '7001' },
      { CELLD_INTERNAL_PORT: '20001' },
      composeNames
    );
    expect(overridden).toEqual(['CELLD_INTERNAL_PORT']);
    expect(() => resolveTunnelPortRange(box)).toThrow(/contains CELLD_INTERNAL_PORT \(20001\)/);
  });

  it('ignores shell variables no compose file interpolates, even ones the .env sets', () => {
    const { box, overridden } = withComposeShellOverrides(
      { FOO_UNRELATED: 'from-env', SAM_DOMAIN: 'box.example' },
      { FOO_UNRELATED: 'from-shell', PATH: '/usr/bin', HOME: '/root' },
      composeNames
    );
    expect(overridden).toEqual([]);
    expect(box).toEqual({ FOO_UNRELATED: 'from-env', SAM_DOMAIN: 'box.example' });
  });

  it('keeps every box port covered even when no compose file references it', () => {
    const { box, overridden } = withComposeShellOverrides({}, { FRPS_BIND_PORT: '25000' }, []);
    expect(overridden).toEqual(['FRPS_BIND_PORT']);
    expect(() => resolveTunnelPortRange(box)).toThrow(/contains FRPS_BIND_PORT \(25000\)/);
  });

  it('control: without a shell override the .env value is checked and passes', () => {
    const { box, overridden } = withComposeShellOverrides(
      { CELLD_INTERNAL_PORT: '7001' },
      {},
      composeNames
    );
    expect(overridden).toEqual([]);
    expect(resolveTunnelPortRange(box)).toEqual({ start: 20000, end: 29999 });
  });
});

describe('composeVariableNames', () => {
  it('finds every interpolated value, not escapes, keys or comments', () => {
    const names = composeVariableNames(
      [
        '# ${IN_A_COMMENT}',
        'services:',
        '  app:',
        '    image: ${IMAGE:-x}',
        '    command: ["$$ESCAPED", "$BARE", "${OUTER:-${INNER}}", "${REQUIRED:?set it}"]',
        '    environment:',
        '      ${AS_A_KEY}: plain',
      ].join('\n')
    );
    expect([...names].sort()).toEqual(['BARE', 'IMAGE', 'INNER', 'OUTER', 'REQUIRED']);
  });

  it('covers the settings the deploy publishes from docker-compose.yml', () => {
    const names = composeFileVariables({}, SELFHOST_DIR);
    for (const name of ['CELLD_BUCKET', 'SAM_DOMAIN', 'SAM_TLS_MODE', 'SAM_MX_LISTEN']) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

describe('sam-mx listen address and unprivileged listeners (S4)', () => {
  it.each([':20500', '0.0.0.0:20500', '[::]:20500', '20500'])(
    'fails the deploy when SAM_MX_LISTEN=%s lies in the range',
    (listen) => {
      expect(() => resolveTunnelPortRange({ SAM_MX_LISTEN: listen })).toThrow(
        /contains SAM_MX_LISTEN \(20500\)/
      );
    }
  );

  it('control: the default :25 and a host-qualified :2525 are accepted', () => {
    expect(resolveTunnelPortRange({ SAM_MX_LISTEN: ':25' })).toEqual({ start: 20000, end: 29999 });
    expect(resolveTunnelPortRange({ SAM_MX_LISTEN: '0.0.0.0:2525' })).toEqual({
      start: 20000,
      end: 29999,
    });
  });

  it.each(['0.0.0.0:', ':x', 'smtp'])('refuses a malformed SAM_MX_LISTEN %s', (listen) => {
    expect(() => resolveTunnelPortRange({ SAM_MX_LISTEN: listen })).toThrow(/SAM_MX_LISTEN/);
  });

  // celld, frps and the collector run with no capability (docker-compose.yml cap_drop: [ALL]).
  it.each(['CELLD_PORT', 'CELLD_INTERNAL_PORT', 'FRPS_BIND_PORT', 'MAIL_COLLECTOR_UI_PORT'])(
    'refuses a privileged port for %s, whose service has no capability',
    (name) => {
      expect(() => resolveTunnelPortRange({ [name]: '80' })).toThrow(
        new RegExp(`${name} must be an integer between 1024`)
      );
    }
  );

  it('control: Caddy and the object store may still sit below 1024', () => {
    expect(resolveTunnelPortRange({ HTTPS_PORT: '8443', OBJECTSTORE_PORT: '900' })).toEqual({
      start: 20000,
      end: 29999,
    });
  });
});

describe('loadBoxEnv (S4: checked before anything starts)', () => {
  const box = (lines: string[]) => {
    const file = join(mkdtempSync(join(tmpdir(), 'sam-box-env-')), '.env');
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    return file;
  };

  it('refuses a box listener inside the lease range, from the .env or the shell', () => {
    expect(() => loadBoxEnv(box(['SAM_MX_LISTEN=:20025']), SELFHOST_DIR, {})).toThrow(
      /contains SAM_MX_LISTEN \(20025\)/
    );
    const reported: string[] = [];
    expect(() =>
      loadBoxEnv(
        box(['CELLD_INTERNAL_PORT=7001']),
        SELFHOST_DIR,
        { CELLD_INTERNAL_PORT: '20001' },
        (name) => reported.push(name)
      )
    ).toThrow(/contains CELLD_INTERNAL_PORT \(20001\)/);
    // The override is reported before the refusal, so the operator sees where it came from.
    expect(reported).toEqual(['CELLD_INTERNAL_PORT']);
  });

  it('control: returns the box with shell overrides applied', () => {
    expect(
      loadBoxEnv(box(['SAM_DOMAIN=box.example', 'CELLD_PORT=8080']), SELFHOST_DIR, {
        CELLD_PORT: '8081',
      })
    ).toEqual({ SAM_DOMAIN: 'box.example', CELLD_PORT: '8081' });
  });

  // docker-compose.yml passes CELLD_BUCKET to celld and SAM_DOMAIN to Caddy: the deploy must
  // publish with the values they run with, and say which came from the shell (never the value).
  it('applies and reports a shell CELLD_BUCKET and SAM_DOMAIN, ignoring unrelated variables', () => {
    const reported: string[] = [];
    const loaded = loadBoxEnv(
      box(['CELLD_BUCKET=gs://fleet/celld', 'SAM_DOMAIN=box.example', 'FOO_UNRELATED=env']),
      SELFHOST_DIR,
      {
        CELLD_BUCKET: 'gs://shell/celld',
        SAM_DOMAIN: 'shell.example',
        FOO_UNRELATED: 'shell',
        PATH: '/usr/bin',
      },
      (name) => reported.push(name)
    );
    expect(reported).toEqual(['CELLD_BUCKET', 'SAM_DOMAIN']);
    expect(loaded).toEqual({
      CELLD_BUCKET: 'gs://shell/celld',
      SAM_DOMAIN: 'shell.example',
      FOO_UNRELATED: 'env',
    });
  });

  it('includes the variables of an overlay the .env selects with COMPOSE_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-box-overlay-'));
    const overlay = join(dir, 'overlay.yml');
    writeFileSync(
      overlay,
      'services:\n  celld:\n    environment:\n      X: ${OVERLAY_SETTING:-x}\n'
    );
    const shell = { OVERLAY_SETTING: 'shell' };
    const selected = loadBoxEnv(
      box([`COMPOSE_FILE=docker-compose.yml:${overlay}`, 'OVERLAY_SETTING=env']),
      SELFHOST_DIR,
      shell
    );
    expect(selected.OVERLAY_SETTING).toBe('shell');
    // Control: without the overlay selected, compose never reads the variable.
    expect(loadBoxEnv(box(['OVERLAY_SETTING=env']), SELFHOST_DIR, shell).OVERLAY_SETTING).toBe(
      'env'
    );
  });
});

describe('gatewayEnvAction', () => {
  const settings = resolveTunnelSettings({});
  const current = renderGatewayEnv(SECRET, settings);
  const longer = renderGatewayEnv(
    SECRET,
    resolveTunnelSettings({ REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '120' })
  );

  it('writes on --init and on a first run, without stopping', () => {
    expect(gatewayEnvAction(null, current, false)).toBe('write');
    expect(gatewayEnvAction(current, longer, true)).toBe('write');
  });

  it('stops a normal deploy when frps would still run the old values', () => {
    expect(gatewayEnvAction(current, longer, false)).toBe('write-then-restart');
  });

  it('control: an unchanged file lets the deploy continue', () => {
    expect(gatewayEnvAction(current, current, false)).toBe('unchanged');
  });
});

describe('syncGatewayEnv', () => {
  /** Everything still readable through a descriptor opened before the write. */
  function readAll(fd: number): string {
    const buffer = Buffer.alloc(4096);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8');
  }

  it('replaces gateway.env whole: a reader that already opened it keeps the old file intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-gateway-env-'));
    const path = join(dir, 'gateway.env');
    const old = 'FRPS_PORT_RANGE=20000-29999\n';
    writeFileSync(path, old, { mode: 0o644 });
    // docker compose reading the env_file while --init rewrites it.
    const reader = openSync(path, 'r');
    try {
      syncGatewayEnv(path, 'FRPS_PORT_RANGE=21000-21999\n', true);
      // Rewritten in place, this descriptor would see the new or a truncated file.
      expect(readAll(reader)).toBe(old);
    } finally {
      closeSync(reader);
    }
    expect(readFileSync(path, 'utf8')).toBe('FRPS_PORT_RANGE=21000-21999\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['gateway.env']);
  });
});
