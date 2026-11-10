import { describe, expect, it } from 'vitest';

import {
  celldChildEnv,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelPortRange,
  tunnelRangeVars,
} from './box-settings.js';
import { parseDotenv } from './secret-files.js';

const SECRET = 'ab'.repeat(32);

describe('tunnel port range', () => {
  it('defaults, and gives the Worker and frps the same values', () => {
    const range = resolveTunnelPortRange({});
    expect(range).toEqual({ start: 20000, end: 29999 });
    const frps = parseDotenv(renderGatewayEnv(SECRET, range), 'gateway.env');
    const worker = tunnelRangeVars(range);
    expect(frps.REVERSE_TUNNEL_PORT_RANGE_START).toBe(worker.REVERSE_TUNNEL_PORT_RANGE_START);
    expect(frps.REVERSE_TUNNEL_PORT_RANGE_END).toBe(worker.REVERSE_TUNNEL_PORT_RANGE_END);
    expect(frps.REVERSE_TUNNEL_GATEWAY_SECRET).toBe(SECRET);
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

  it('refuses a gateway secret that is not 32 bytes of hex', () => {
    expect(() => renderGatewayEnv('short', resolveTunnelPortRange({}))).toThrow(/32 bytes/);
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
