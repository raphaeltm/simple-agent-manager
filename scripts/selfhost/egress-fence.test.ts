import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertPresignCredentialIsScoped } from './box-settings.js';
import {
  buildFencePlan,
  FORBIDDEN_IPV4,
  FORBIDDEN_IPV6,
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

  it('allows DNS only to the configured nameservers, before the link-local drop', () => {
    const rules = renderFenceRuleset(plan());
    const dns = rules.indexOf(
      'ip daddr { 127.0.0.53, 169.254.169.254 } meta l4proto { tcp, udp } th dport 53 accept'
    );
    expect(dns).toBeGreaterThan(0);
    expect(dns).toBeLessThan(rules.indexOf('169.254.0.0/16'));
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
    for (const range of ['::/127', 'fc00::/7', 'fe80::/10', '::ffff:0:0/96']) {
      expect(FORBIDDEN_IPV6).toContain(range);
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
    { label: 'metadata', host: '169.254.169.254', port: 80, expect: 'blocked' },
    { label: 'ipv6', host: '::1', port: 7001, expect: 'blocked' },
    { label: 'lease', host: '127.0.0.1', port: 20000, expect: 'reachable' },
    { label: 'public', host: '1.1.1.1', port: 443, expect: 'reachable' },
  ];
  const control = parseProbeOutput('0 open\n1 timeout\n2 refused\n3 refused\n4 open\n');

  it('passes when forbidden targets are blocked for celld and not for another uid', () => {
    const verdict = evaluateProbes(
      targets,
      parseProbeOutput('0 blocked\n1 blocked\n2 blocked\n3 refused\n4 open\n'),
      control
    );
    expect(verdict).toEqual({ failures: [], warnings: [] });
  });

  it.each(['open', 'refused', 'timeout', 'error'])(
    'fails when a forbidden target is %s',
    (outcome) => {
      const verdict = evaluateProbes(
        targets,
        parseProbeOutput(`0 ${outcome}\n1 blocked\n2 blocked\n3 open\n4 open\n`),
        control
      );
      expect(verdict.failures).toEqual([expect.stringMatching(/operator .* NOT fenced/)]);
    }
  );

  it('a loopback target refused for every uid fails: the probe cannot see the fence', () => {
    const verdict = evaluateProbes(
      targets,
      parseProbeOutput('0 blocked\n1 blocked\n2 blocked\n3 open\n4 open\n'),
      parseProbeOutput('0 blocked\n1 timeout\n2 refused\n')
    );
    expect(verdict.failures).toEqual([expect.stringMatching(/operator .*cannot see the fence/)]);
  });

  it('a remote target the network refuses for every uid is a warning, not a pass or a failure', () => {
    const verdict = evaluateProbes(
      targets,
      parseProbeOutput('0 blocked\n1 blocked\n2 blocked\n3 open\n4 open\n'),
      parseProbeOutput('0 open\n1 blocked\n2 refused\n')
    );
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toEqual([expect.stringMatching(/metadata .*inconclusive/)]);
  });

  it('IPv6 off on the host is not applicable, not a failure', () => {
    const verdict = evaluateProbes(
      targets,
      parseProbeOutput('0 blocked\n1 blocked\n2 unavailable\n3 open\n4 open\n'),
      parseProbeOutput('0 open\n1 timeout\n2 unavailable\n')
    );
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toEqual([expect.stringMatching(/ipv6 .*not applicable/)]);
  });

  it.each(['blocked', 'timeout', 'error', 'unavailable'])(
    'fails when an allowed target is %s',
    (outcome) => {
      const verdict = evaluateProbes(
        targets,
        parseProbeOutput(`0 blocked\n1 blocked\n2 blocked\n3 open\n4 ${outcome}\n`),
        control
      );
      expect(verdict.failures).toEqual([expect.stringMatching(/public .*should be reachable/)]);
    }
  );

  it('fails on a missing result and ignores garbage lines', () => {
    const verdict = evaluateProbes(
      targets,
      parseProbeOutput('noise\n0 blocked\n1 blocked\n2 blocked\n3 open\n7 maybe\n'),
      control
    );
    expect(verdict.failures).toEqual(['public: no result']);
  });

  it('builds one probe line per target', () => {
    const script = buildProbeScript(targets, 3);
    expect(script).toContain("probe 0 '127.0.0.1' 7001");
    expect(script).toContain("probe 3 '127.0.0.1' 20000");
    expect(script).toContain('No route to host');
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
