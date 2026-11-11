import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertPresignCredentialIsScoped } from './box-settings.js';
import {
  buildFencePlan,
  DEFAULT_GCE_METADATA_PROXY_SCOPES,
  FORBIDDEN_IPV4,
  FORBIDDEN_IPV6,
  metadataProxyEnabled,
  metadataProxyScopes,
  parseNameservers,
  renderCelldEnv,
  renderDnsRules,
  renderFenceRuleset,
  resolveObjectStoreEndpoints,
} from './egress-fence.js';
import { assertComposeProfiles, writeFenceFiles } from './fence-state.js';
import { parseDotenv } from './secret-files.js';

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
    expect(rules.indexOf('ct state established')).toBeLessThan(rules.indexOf('counter reject'));
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

  it('allows DNS only to the nameservers, in chain dns, jumped to before any refusal', () => {
    const rules = renderFenceRuleset(plan());
    expect(rules).toContain(
      '  chain dns {\n    ip daddr { 127.0.0.53, 169.254.169.254 } meta l4proto { tcp, udp } th dport 53 accept comment "DNS"\n  }'
    );
    expect(rules.indexOf('jump dns')).toBeGreaterThan(0);
    expect(rules.indexOf('jump dns')).toBeLessThan(rules.indexOf('counter reject'));
    // Anonymous sets only: Debian 12's nft 1.0.6 crashes listing a named set a newer nft created.
    expect(rules).not.toMatch(/^\s*set /m);
    expect(renderDnsRules(['10.0.0.2', 'fd00::53'])).toEqual([
      'ip daddr { 10.0.0.2 } meta l4proto { tcp, udp } th dport 53 accept comment "DNS"',
      'ip6 daddr { fd00::53 } meta l4proto { tcp, udp } th dport 53 accept comment "DNS"',
    ]);
  });

  it('refuses this host and every forbidden range, in the right family, after every accept', () => {
    const rules = renderFenceRuleset(
      plan({ CELLD_BUCKET: 'gs://b', SAM_EGRESS_ALLOW: '10.0.0.5:11434' }, [
        { address: '10.1.2.3', port: 9000 },
      ])
    ).split('\n');
    const refuse = 'counter reject with icmpx admin-prohibited';
    const v4 = rules.findIndex(
      (line) => line.trim().startsWith('ip daddr {') && line.includes(refuse)
    );
    const v6 = rules.findIndex(
      (line) => line.trim().startsWith('ip6 daddr {') && line.includes(refuse)
    );
    const local = rules.findIndex((line) => line.includes(`fib daddr type local ${refuse}`));
    expect(rules[v4]).toContain(`ip daddr { ${FORBIDDEN_IPV4.join(', ')} } ${refuse}`);
    expect(rules[v6]).toContain(`ip6 daddr { ${FORBIDDEN_IPV6.join(', ')} } ${refuse}`);
    const firstRefuse = Math.min(v4, v6, local);
    const lastAccept = Math.max(
      ...rules.map((line, index) => (line.includes(' accept') ? index : -1))
    );
    expect(local).toBeGreaterThan(0);
    expect(lastAccept).toBeLessThan(firstRefuse);
    for (const range of ['10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '168.63.129.16/32']) {
      expect(FORBIDDEN_IPV4).toContain(range);
    }
    for (const range of ['::/96', 'fc00::/7', 'fe80::/10', '::ffff:0:0/96']) {
      expect(FORBIDDEN_IPV6).toContain(range);
    }
  });

  it('refuses the IPv6 transition ranges the API classifier refuses (6to4, Teredo, ::/96)', () => {
    for (const range of ['2002::/16', '2001::/32', '::/96', '::ffff:0:0:0/96', '64:ff9b::/96']) {
      expect(FORBIDDEN_IPV6).toContain(range);
    }
    for (const range of ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '192.88.99.0/24']) {
      expect(FORBIDDEN_IPV4).toContain(range);
    }
  });

  it('lets celld reach Caddy on its own non-loopback addresses, only on the HTTP(S) ports', () => {
    const rules = renderFenceRuleset(plan({ HTTPS_PORT: '8443' }));
    expect(rules).toContain(
      'ip daddr != 127.0.0.0/8 fib daddr type local tcp dport { 80, 8443 } accept'
    );
    expect(rules).toContain('ip6 daddr != ::1 fib daddr type local tcp dport { 80, 8443 } accept');
    // No unqualified local accept: that would also open 127.0.0.1:80 and every local address.
    expect(rules).not.toMatch(/^\s*fib daddr type local tcp dport/m);
  });

  it('allows the bundled object store port, and a LAN store at its exact address', () => {
    expect(renderFenceRuleset(plan({}, [{ address: '127.0.0.1', port: 9000 }]))).toContain(
      'ip daddr 127.0.0.1 tcp dport { 20000-29999, 9000 } accept'
    );
    expect(renderFenceRuleset(plan({}, [{ address: '10.1.2.3', port: 9000 }]))).toContain(
      'ip daddr 10.1.2.3 tcp dport 9000 accept comment "object store or allowed endpoint"'
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

  it('opens an operator-allowed endpoint (SAM_EGRESS_ALLOW) at its exact address and port', () => {
    const rules = renderFenceRuleset(
      plan({ SAM_EGRESS_ALLOW: '127.0.0.1:11434, 10.0.0.5:8000,[fd00::5]:8080' })
    );
    expect(rules).toContain('ip daddr 127.0.0.1 tcp dport { 20000-29999, 11434 } accept');
    expect(rules).toContain('ip daddr 10.0.0.5 tcp dport 8000 accept');
    expect(rules).toContain('ip6 daddr fd00::5 tcp dport 8080 accept');
  });

  it.each(['ollama:11434', '10.0.0.5', '10.0.0.5:0', 'http://10.0.0.5:80'])(
    'refuses a malformed SAM_EGRESS_ALLOW entry (%s)',
    (entry) => {
      expect(() => plan({ SAM_EGRESS_ALLOW: entry })).toThrow(/SAM_EGRESS_ALLOW/);
    }
  );

  it.each([
    '169.254.169.254:80',
    '[fe80::1]:80',
    '100.100.100.200:80',
    '168.63.129.16:80',
    '0.0.0.0:80',
    '[fd20:ce::254]:80',
  ])('refuses an allowlist entry for a metadata or link-local address (%s)', (entry) => {
    expect(() => plan({ SAM_EGRESS_ALLOW: entry })).toThrow(/metadata, link-local or reserved/);
  });

  it.each([
    ['127.0.0.1:7001', []],
    ['127.0.0.2:7001', []],
    ['[::1]:8080', []],
    ['203.0.113.7:7000', ['203.0.113.7']],
  ])('refuses an allowed endpoint that opens a listener (%s)', (entry, localAddresses) => {
    expect(() =>
      buildFencePlan({
        box: { SAM_EGRESS_ALLOW: entry },
        leaseRange: RANGE,
        resolvConf: RESOLV,
        objectStore: [],
        localAddresses,
      })
    ).toThrow(/egress fence would allow/);
  });

  it('control: the same port on a remote address is fine', () => {
    expect(() => plan({ SAM_EGRESS_ALLOW: '203.0.113.7:7000' })).not.toThrow();
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

describe('operator endpoints never open metadata, link-local or reserved addresses', () => {
  it.each([
    '169.254.169.254',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::1',
    'fe80::1',
    'fd00:ec2::254',
    'fd20:ce::254',
    '100.100.100.200',
    '168.63.129.16',
    '0.0.0.0',
    '::ffff:0:a9fe:a9fe',
    '::ffff:0:169.254.169.254',
    '::a9fe:a9fe',
    '::169.254.169.254',
    '64:ff9b:1::a9fe:a9fe',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ])('S3_ENDPOINT resolving to %s is refused', async (address) => {
    await expect(
      resolveObjectStoreEndpoints({ S3_ENDPOINT: 'https://store.example' }, async () => [address])
    ).rejects.toThrow(/never opens it/);
    expect(() => plan({}, [{ address, port: 80 }])).toThrow(/never opens it/);
  });

  it('control: private, loopback and public store addresses stay openable', async () => {
    for (const address of [
      '10.0.0.9',
      '127.0.0.1',
      '::1',
      '::ffff:10.0.0.9',
      '192.168.1.5',
      'fd12::5',
      '203.0.114.9',
    ]) {
      expect(
        await resolveObjectStoreEndpoints({ S3_ENDPOINT: 'https://store.example' }, async () => [
          address,
        ])
      ).toEqual([{ address, port: 443 }]);
    }
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
  it('lists one start-check probe per rule class, local spellings on the operator port', () => {
    const withHost = buildFencePlan({
      box: {},
      leaseRange: RANGE,
      resolvConf: RESOLV,
      objectStore: [],
      localAddresses: ['127.0.0.1', '::1', 'fe80::1', '10.0.0.4', '2a01:4f8::1'],
    });
    const env = parseDotenv(renderCelldEnv({}, withHost, ''), 'celld.env');
    expect(Object.keys(env)).toEqual(['SAM_EGRESS_FENCE_PROBES']);
    expect(env.SAM_EGRESS_FENCE_PROBES!.split(' ')).toEqual([
      'loopback-v4,127.0.0.1,7001',
      'loopback-other-v4,127.0.0.2,7001',
      'loopback-v6,::1,7001',
      'host-address-v4,10.0.0.4,7001',
      'host-address-v6,2a01:4f8::1,7001',
      'private-v4,10.255.255.1,80',
      'metadata-v4,169.254.169.254,80',
      'cgnat-v4,100.100.100.200,80',
      'unique-local-v6,fd00::1,80',
      'metadata-v6,fd20:ce::254,80',
      '6to4-v6,2002:a9fe:a9fe::1,80',
      'teredo-v6,2001::1,80',
    ]);
  });

  it('forces a Cloud Storage scope on the token proxy and refuses any other scope', () => {
    const box = { CELLD_BUCKET: 'gs://b' };
    const env = parseDotenv(renderCelldEnv(box, plan(box), SECRET), 'celld.env');
    expect(env.GCE_METADATA_PROXY_SCOPES).toBe(DEFAULT_GCE_METADATA_PROXY_SCOPES);
    expect(DEFAULT_GCE_METADATA_PROXY_SCOPES).toBe(
      'https://www.googleapis.com/auth/devstorage.read_write'
    );
    expect(
      metadataProxyScopes({
        GCE_METADATA_PROXY_SCOPES: 'https://www.googleapis.com/auth/devstorage.read_only',
      })
    ).toBe('https://www.googleapis.com/auth/devstorage.read_only');
    for (const scope of [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/ndev.clouddns.readwrite',
      'https://www.googleapis.com/auth/devstorage.read_write,https://www.googleapis.com/auth/cloud-platform',
    ]) {
      expect(() => metadataProxyScopes({ GCE_METADATA_PROXY_SCOPES: scope })).toThrow(
        /not a Cloud Storage scope/
      );
    }
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
