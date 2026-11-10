import { describe, expect, it } from 'vitest';

import {
  BOX_RESERVED_PORTS,
  celldChildEnv,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelPortRange,
  resolveTunnelSettings,
  tunnelWorkerVars,
} from './box-settings.js';
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
      expect(() =>
        resolveTunnelPortRange({ [name]: '20500' })
      ).toThrow(new RegExp(`contains ${name} \\(20500\\)`));
      // Control: the same listener moved just outside the range is accepted.
      expect(resolveTunnelPortRange({ [name]: '30000' })).toEqual({ start: 20000, end: 29999 });
    }
  );

  it('derives the reuse age floor from the heartbeat timeout frps gets', () => {
    expect(resolveTunnelSettings({ REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '120' })).toMatchObject(
      { heartbeatTimeoutSeconds: 120, portReuseMinAgeSeconds: null }
    );
    expect(() =>
      resolveTunnelSettings({ REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '30' })
    ).toThrow(/between 60 and 3600/);
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
    });
  });

  it('gives Azure buckets no presign vars', () => {
    expect(presignVars({ CELLD_BUCKET: 'az://container' }, 'assets')).toEqual({});
  });
});
