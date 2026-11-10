import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertPresignCredentialIsScoped } from './box-settings.js';
import {
  buildFencePlan,
  metadataProxyEnabled,
  parseNameservers,
  renderCelldEnv,
  renderFenceRuleset,
  resolveObjectStoreEndpoints,
} from './egress-fence.js';
import { assertComposeProfiles, writeFenceFiles } from './fence-state.js';
import { parseDotenv } from './secret-files.js';
import {
  buildProbeScript,
  evaluateProbes,
  fenceTargets,
  parseProbeOutput,
  type ProbeTarget,
} from './verify-fence.js';

const RANGE = { start: 20000, end: 29999 };
const RESOLV = 'nameserver 127.0.0.53\nnameserver 169.254.169.254\noptions edns0\n';
const SECRET = 'cd'.repeat(32);

function plan(
  box: Record<string, string> = {},
  objectStore = [] as { address: string; port: number }[]
) {
  return buildFencePlan({ box, leaseRange: RANGE, resolvConf: RESOLV, objectStore });
}

describe('egress fence ruleset', () => {
  it('fences only the celld uid and lets established traffic (Caddy -> celld replies) through', () => {
    const rules = renderFenceRuleset(plan());
    expect(rules).toContain('meta skuid 7101 jump celld');
    expect(rules).toContain('ct state established,related accept');
    expect(rules.indexOf('ct state established')).toBeLessThan(rules.indexOf('counter drop'));
  });

  it('replaces the table atomically: create, delete, define in one file', () => {
    const rules = renderFenceRuleset(plan());
    expect(rules).toMatch(
      /^table inet sam_celld_egress\ndelete table inet sam_celld_egress\ntable inet sam_celld_egress \{/m
    );
  });

  it('allows the lease range and nothing else on loopback by default', () => {
    const rules = renderFenceRuleset(plan());
    expect(rules).toContain('ip daddr 127.0.0.1 tcp dport 20000-29999 accept');
    for (const port of ['7001', '8080', '7000', '9001', '2019']) {
      expect(rules).not.toMatch(new RegExp(`127\\.0\\.0\\.1 tcp dport[^\\n]*\\b${port}\\b`));
    }
  });

  it('allows DNS only to the configured nameservers, before the link-local drop', () => {
    const rules = renderFenceRuleset(plan());
    const dns = rules.indexOf(
      'ip daddr { 127.0.0.53, 169.254.169.254 } meta l4proto { tcp, udp } th dport 53 accept'
    );
    expect(dns).toBeGreaterThan(0);
    expect(dns).toBeLessThan(rules.indexOf('169.254.0.0/16'));
  });

  it('drops this host, private, link-local, CGNAT and IPv6 local ranges', () => {
    const rules = renderFenceRuleset(plan());
    expect(rules).toContain('fib daddr type local counter drop');
    for (const range of [
      '10.0.0.0/8',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
    ]) {
      expect(rules).toContain(range);
    }
    for (const range of ['::/127', 'fc00::/7', 'fe80::/10', '::ffff:0:0/96']) {
      expect(rules).toContain(range);
    }
  });

  it('lets celld reach Caddy on its own addresses, but only on the HTTP(S) ports', () => {
    expect(renderFenceRuleset(plan({ HTTPS_PORT: '8443' }))).toContain(
      'fib daddr type local tcp dport { 80, 8443 } accept'
    );
  });

  it('allows the bundled object store port, and a LAN store at its exact address', () => {
    expect(renderFenceRuleset(plan({}, [{ address: '127.0.0.1', port: 9000 }]))).toContain(
      'ip daddr 127.0.0.1 tcp dport { 20000-29999, 9000 } accept'
    );
    expect(renderFenceRuleset(plan({}, [{ address: '10.1.2.3', port: 9000 }]))).toContain(
      'ip daddr 10.1.2.3 tcp dport 9000 accept comment "object store"'
    );
  });

  it('allows the metadata token proxy port, never the metadata server, for a gs:// bucket', () => {
    const rules = renderFenceRuleset(plan({ CELLD_BUCKET: 'gs://b/celld' }));
    expect(rules).toContain('ip daddr 127.0.0.1 tcp dport { 20000-29999, 7180 } accept');
    expect(rules).not.toMatch(/169\.254\.169\.254[^\n]*tcp dport 80/);
  });

  it('follows CELLD_UID', () => {
    expect(renderFenceRuleset(plan({ CELLD_UID: '7300' }))).toContain('meta skuid 7300 jump celld');
    expect(() => plan({ CELLD_UID: '0' })).toThrow(/CELLD_UID/);
  });

  it.each([
    ['CELLD_INTERNAL_PORT', { CELLD_INTERNAL_PORT: '20001' }],
    ['CELLD_PORT', { CELLD_PORT: '25000' }],
    ['FRPS_BIND_PORT', { FRPS_BIND_PORT: '29999' }],
    ['OBJECTSTORE_CONSOLE_PORT', { OBJECTSTORE_CONSOLE_PORT: '20000' }],
  ])('refuses a plan whose lease range would open %s', (_name, box) => {
    expect(() => plan(box)).toThrow(/egress fence would allow/);
  });

  it("refuses a plan that would open celld's operator port as the object store port", () => {
    expect(() => plan({}, [{ address: '127.0.0.1', port: 7001 }])).toThrow(/CELLD_INTERNAL_PORT/);
  });

  it('refuses a box with no nameserver', () => {
    expect(() =>
      buildFencePlan({ box: {}, leaseRange: RANGE, resolvConf: '# none\n', objectStore: [] })
    ).toThrow(/nameserver/);
  });
});

describe('parseNameservers', () => {
  it('keeps IP literals, drops zone ids and junk, dedupes', () => {
    expect(
      parseNameservers(
        'nameserver 1.1.1.1\nnameserver fe80::1%eth0\nnameserver bogus\nnameserver 1.1.1.1\n'
      )
    ).toEqual(['1.1.1.1', 'fe80::1']);
  });
});

describe('object store endpoints', () => {
  it('none without S3_ENDPOINT; literal and resolved addresses with the right port', async () => {
    expect(await resolveObjectStoreEndpoints({})).toEqual([]);
    expect(await resolveObjectStoreEndpoints({ S3_ENDPOINT: 'http://127.0.0.1:9000' })).toEqual([
      { address: '127.0.0.1', port: 9000 },
    ]);
    expect(
      await resolveObjectStoreEndpoints({ S3_ENDPOINT: 'https://minio.lan' }, async () => [
        '10.0.0.9',
      ])
    ).toEqual([{ address: '10.0.0.9', port: 443 }]);
  });
});

describe('celld.env and the metadata token proxy', () => {
  it('names the start check canary (celld operator port)', () => {
    const env = parseDotenv(renderCelldEnv({}, plan(), ''), 'celld.env');
    expect(env).toEqual({ SAM_EGRESS_FENCE_CANARY: '127.0.0.1:7001' });
  });

  it('points celld at the proxy with the secret path for a gs:// bucket', () => {
    const box = { CELLD_BUCKET: 'gs://b' };
    const env = parseDotenv(renderCelldEnv(box, plan(box), SECRET), 'celld.env');
    expect(env.GCE_METADATA_HOST).toBe(`127.0.0.1:7180/${SECRET}`);
    expect(env.GCE_METADATA_IP).toBe(env.GCE_METADATA_HOST);
    expect(env.GCE_METADATA_PROXY_SECRET).toBe(SECRET);
  });

  it('on for gs:// by default, off for s3://, overridable', () => {
    expect(metadataProxyEnabled({ CELLD_BUCKET: 'gs://b' })).toBe(true);
    expect(metadataProxyEnabled({ CELLD_BUCKET: 's3://b' })).toBe(false);
    expect(metadataProxyEnabled({ CELLD_BUCKET: 'gs://b', GCE_METADATA_PROXY: 'off' })).toBe(false);
  });

  it('requires the gce compose profile exactly when the proxy is on', () => {
    expect(() =>
      assertComposeProfiles({ CELLD_BUCKET: 'gs://b', COMPOSE_PROFILES: 'tunnel' })
    ).toThrow(/gce/);
    expect(() =>
      assertComposeProfiles({ CELLD_BUCKET: 'gs://b', COMPOSE_PROFILES: 'tunnel,gce' })
    ).not.toThrow();
    expect(() =>
      assertComposeProfiles({ CELLD_BUCKET: 's3://b', COMPOSE_PROFILES: 'gce' })
    ).toThrow(/remove/);
  });

  it('writes the ruleset world-readable, celld.env private, and keeps the proxy secret stable', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fence-'));
    const box = { CELLD_BUCKET: 'gs://b', COMPOSE_PROFILES: 'tunnel,gce' };
    const first = await writeFenceFiles({ stateDir, box, leaseRange: RANGE, resolvConf: RESOLV });
    expect(first.changed).toHaveLength(2);
    expect(statSync(join(stateDir, 'egress-fence.nft')).mode & 0o777).toBe(0o644);
    expect(statSync(join(stateDir, 'celld.env')).mode & 0o777).toBe(0o600);
    const envBefore = readFileSync(join(stateDir, 'celld.env'), 'utf8');
    const second = await writeFenceFiles({ stateDir, box, leaseRange: RANGE, resolvConf: RESOLV });
    expect(second.changed).toEqual([]);
    expect(readFileSync(join(stateDir, 'celld.env'), 'utf8')).toBe(envBefore);
  });
});

describe('presign credential', () => {
  it('refuses the fleet credential as the presign credential', () => {
    const box = { AWS_ACCESS_KEY_ID: 'fleet-key', AWS_SECRET_ACCESS_KEY: 'fleet-secret' };
    expect(() => assertPresignCredentialIsScoped(box, { R2_ACCESS_KEY_ID: 'fleet-key' })).toThrow(
      /R2_ACCESS_KEY_ID is the fleet bucket credential/
    );
    expect(() =>
      assertPresignCredentialIsScoped(box, {
        R2_ACCESS_KEY_ID: 'scoped',
        R2_SECRET_ACCESS_KEY: 'fleet-secret',
      })
    ).toThrow(/R2_SECRET_ACCESS_KEY/);
  });

  it('control: accepts a scoped credential, and no credential at all', () => {
    const box = { AWS_ACCESS_KEY_ID: 'fleet-key', AWS_SECRET_ACCESS_KEY: 'fleet-secret' };
    expect(() =>
      assertPresignCredentialIsScoped(box, {
        R2_ACCESS_KEY_ID: 'scoped',
        R2_SECRET_ACCESS_KEY: 'scoped-secret',
      })
    ).not.toThrow();
    expect(() => assertPresignCredentialIsScoped({}, {})).not.toThrow();
  });
});

describe('verify-fence', () => {
  const targets: ProbeTarget[] = [
    { label: 'operator', host: '127.0.0.1', port: 7001, expect: 'blocked' },
    { label: 'lease', host: '127.0.0.1', port: 20000, expect: 'reachable' },
  ];

  it('passes when forbidden targets are blocked and allowed ones are not', () => {
    expect(evaluateProbes(targets, parseProbeOutput('0 blocked\n1 refused\n'))).toEqual([]);
  });

  it.each(['open', 'refused', 'timeout', 'error'])(
    'fails when a forbidden target is %s',
    (outcome) => {
      expect(evaluateProbes(targets, parseProbeOutput(`0 ${outcome}\n1 open\n`))[0]).toMatch(
        /NOT fenced/
      );
    }
  );

  it('fails when an allowed target is blocked, or a result is missing', () => {
    expect(evaluateProbes(targets, parseProbeOutput('0 blocked\n1 blocked\n'))[0]).toMatch(
      /should be allowed/
    );
    expect(evaluateProbes(targets, parseProbeOutput('0 blocked\n'))[0]).toMatch(/no result/);
  });

  it('builds one probe line per target', () => {
    const script = buildProbeScript(targets, 3);
    expect(script).toContain("probe 0 '127.0.0.1' 7001");
    expect(script).toContain("probe 1 '127.0.0.1' 20000");
    expect(script).toContain('Operation not permitted');
  });

  it('checks every listener celld must not reach, plus the allowed ones for this box', async () => {
    const all = await fenceTargets({ CELLD_BUCKET: 'gs://b' }, '1.1.1.1:443');
    const blocked = all.filter((t) => t.expect === 'blocked').map((t) => `${t.host}:${t.port}`);
    expect(blocked).toEqual(
      expect.arrayContaining([
        '127.0.0.1:7001',
        '127.0.0.1:8080',
        '127.0.0.1:7000',
        '169.254.169.254:80',
        '::1:7001',
      ])
    );
    const allowed = all.filter((t) => t.expect === 'reachable').map((t) => `${t.host}:${t.port}`);
    expect(allowed).toEqual(['127.0.0.1:20000', '1.1.1.1:443', '127.0.0.1:7180']);
  });
});
