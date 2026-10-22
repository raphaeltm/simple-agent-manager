import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_EMAIL_LOCAL_PART as SHARED_LOCAL_PART,
  AGENT_EMAIL_SUBDOMAIN_LABEL as SHARED_SUBDOMAIN_LABEL,
} from '../../packages/shared/src/constants/agent-email';
import type { CloudflareRequest, CloudflareResponse, HttpMethod } from '../deploy/cloudflare-rest';
import {
  AGENT_EMAIL_LOCAL_PART,
  AGENT_EMAIL_SUBDOMAIN_LABEL,
  configureAgentEmail,
  type DnsRecord,
  readAgentEmailMarker,
  writeAgentEmailMarker,
} from '../deploy/configure-agent-email';

const ZONE = 'zone-1';
const WORKER = 'sam-api-staging';

type Permission = 'zoneSettings' | 'routingRules' | 'sending';

interface FakeRule {
  id: string;
  name: string;
  enabled: boolean;
  matchers: Array<{ type: string; field: string; value: string }>;
  actions: Array<{ type: string; value: string[] }>;
}

/**
 * Strict in-memory Cloudflare peer. It accepts only the documented request shapes the
 * real API takes, rejects unknown routes, and applies writes to its state so that a
 * second run can prove idempotency.
 */
class FakeCloudflare {
  permissions = new Set<Permission>(['zoneSettings', 'routingRules', 'sending']);
  zoneName = 'fixture.example';
  routing = { enabled: false, support_subaddress: false };
  dns: DnsRecord[] = [];
  rules: FakeRule[] = [];
  sending: Array<{ tag: string; name: string; enabled: boolean }> = [];
  sendingDns: Record<string, DnsRecord[]> = {};
  /** Test hook: what enabling routing for a subdomain does to the apex. */
  onEnableSubdomain: ((fake: FakeCloudflare) => void) | null = null;
  calls: Array<{ method: HttpMethod; path: string }> = [];

  request: CloudflareRequest = async (method, path, body) => {
    this.calls.push({ method, path });
    return this.handle(method, path, body);
  };

  private ok(result: unknown): CloudflareResponse {
    return { status: 200, body: { success: true, result } };
  }

  private denied(): CloudflareResponse {
    return {
      status: 403,
      body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    };
  }

  private handle(method: HttpMethod, rawPath: string, body: unknown): CloudflareResponse {
    const [path, query = ''] = rawPath.split('?');
    const params = new URLSearchParams(query);
    const zonePrefix = `/zones/${ZONE}`;
    if (!path.startsWith(zonePrefix)) throw new Error(`unexpected path ${rawPath}`);
    const route = `${method} ${path.slice(zonePrefix.length) || '/'}`;

    if (route === 'GET /') return this.ok({ id: ZONE, name: this.zoneName });
    if (route === 'GET /dns_records') {
      const type = params.get('type');
      const name = params.get('name');
      return this.ok(this.dns.filter((r) => r.type === type && r.name === name));
    }
    if (route === 'POST /dns_records') {
      const record = body as DnsRecord & { ttl: number; proxied: boolean };
      expect(record).toMatchObject({
        type: expect.any(String),
        name: expect.any(String),
        content: expect.any(String),
        ttl: 1,
        proxied: false,
      });
      this.dns.push({
        type: record.type,
        name: record.name,
        content: record.content,
        priority: record.priority,
      });
      return this.ok({ id: `dns-${this.dns.length}` });
    }
    if (path.startsWith(`${zonePrefix}/email/routing`)) {
      if (!this.permissions.has(path.includes('/rules') ? 'routingRules' : 'zoneSettings'))
        return this.denied();
    }
    if (path.startsWith(`${zonePrefix}/email/sending`) && !this.permissions.has('sending')) {
      return this.denied();
    }
    if (route === 'GET /email/routing') return this.ok({ name: this.zoneName, ...this.routing });
    if (route === 'PATCH /email/routing') {
      expect(body).toEqual({ support_subaddress: true });
      this.routing.support_subaddress = true;
      return this.ok({ name: this.zoneName, ...this.routing });
    }
    if (route === 'POST /email/routing/dns') {
      const { name } = body as { name: string };
      expect(name).toMatch(/^mail\./);
      for (const [priority, host] of [
        [13, 'route1'],
        [86, 'route2'],
        [24, 'route3'],
      ] as const) {
        this.dns.push({ type: 'MX', name, content: `${host}.mx.cloudflare.net`, priority });
      }
      this.dns.push({ type: 'TXT', name, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
      this.onEnableSubdomain?.(this);
      return this.ok({ name, enabled: true, status: 'ready' });
    }
    if (route === 'GET /email/routing/rules') {
      const page = Number(params.get('page') ?? '1');
      const perPage = Number(params.get('per_page') ?? '20');
      return this.ok(this.rules.slice((page - 1) * perPage, page * perPage));
    }
    if (route === 'POST /email/routing/rules') {
      const rule = body as Omit<FakeRule, 'id'>;
      this.assertRuleShape(rule);
      this.rules.push({ id: `rule-${this.rules.length + 1}`, ...rule });
      return this.ok(this.rules.at(-1));
    }
    const ruleUpdate = /^PUT \/email\/routing\/rules\/(.+)$/.exec(route);
    if (ruleUpdate) {
      const rule = body as Omit<FakeRule, 'id'>;
      this.assertRuleShape(rule);
      const index = this.rules.findIndex((r) => r.id === ruleUpdate[1]);
      expect(index).toBeGreaterThanOrEqual(0);
      this.rules[index] = { id: ruleUpdate[1]!, ...rule };
      return this.ok(this.rules[index]);
    }
    if (route === 'GET /email/sending/subdomains') return this.ok(this.sending);
    if (route === 'POST /email/sending/subdomains') {
      const { name } = body as { name: string };
      const tag = `tag-${this.sending.length + 1}`;
      this.sending.push({ tag, name, enabled: true });
      this.sendingDns[tag] = [
        {
          type: 'MX',
          name: `cf-bounce.${name}`,
          content: 'route1.mx.cloudflare.net',
          priority: 10,
        },
        {
          type: 'TXT',
          name: `cf-bounce.${name}`,
          content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
        },
        { type: 'TXT', name: `cf-bounce._domainkey.${name}`, content: 'v=DKIM1; k=rsa; p=MIIB' },
        { type: 'TXT', name: `_dmarc.${name}`, content: 'v=DMARC1; p=none' },
      ];
      return this.ok(this.sending.at(-1));
    }
    const sendingDns = /^GET \/email\/sending\/subdomains\/([^/]+)\/dns$/.exec(route);
    if (sendingDns) return this.ok(this.sendingDns[sendingDns[1]!] ?? []);
    throw new Error(`unexpected route ${route}`);
  }

  private assertRuleShape(rule: Omit<FakeRule, 'id'>): void {
    expect(rule).toEqual({
      name: expect.any(String),
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: expect.stringMatching(/^agent@mail\./) }],
      actions: [{ type: 'worker', value: [expect.any(String)] }],
    });
  }

  writes(): number {
    return this.calls.filter((call) => call.method !== 'GET').length;
  }
}

function run(fake: FakeCloudflare) {
  return configureAgentEmail(fake.request, {
    zoneId: ZONE,
    baseDomain: 'fixture.example',
    workerName: WORKER,
  });
}

describe('configureAgentEmail', () => {
  it('stays off without writing anything when the token cannot read Email Sending', async () => {
    const fake = new FakeCloudflare();
    fake.permissions.delete('sending');

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('Email Sending'),
    });
    expect(fake.writes()).toBe(0);
  });

  it('never touches a zone whose apex already receives mail elsewhere', async () => {
    const fake = new FakeCloudflare();
    fake.dns.push({ type: 'MX', name: 'fixture.example', content: 'smtp.google.com', priority: 1 });

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('smtp.google.com'),
    });
    expect(fake.writes()).toBe(0);
    expect(fake.dns.filter((r) => r.name === 'fixture.example')).toEqual([
      { type: 'MX', name: 'fixture.example', content: 'smtp.google.com', priority: 1 },
    ]);
  });

  it('configures routing, subaddressing, the worker rule and sending, then is idempotent', async () => {
    const fake = new FakeCloudflare();

    const first = await run(fake);

    expect(first).toMatchObject({
      status: 'configured',
      domain: 'mail.fixture.example',
      apexMailRecordsAdded: [],
      sendingEnabled: true,
    });
    expect(fake.dns.some((r) => r.type === 'MX' && r.name === 'mail.fixture.example')).toBe(true);
    expect(fake.routing.support_subaddress).toBe(true);
    expect(fake.rules).toEqual([
      {
        id: 'rule-1',
        name: 'SAM agent email',
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: 'agent@mail.fixture.example' }],
        actions: [{ type: 'worker', value: [WORKER] }],
      },
    ]);
    expect(fake.sending.map((s) => s.name)).toEqual(['mail.fixture.example']);
    for (const record of fake.sendingDns['tag-1']!) {
      expect(fake.dns).toContainEqual(
        expect.objectContaining({ type: record.type, name: record.name })
      );
    }
    // The apex is not touched.
    expect(fake.dns.filter((r) => r.name === 'fixture.example')).toEqual([]);

    const writesAfterFirst = fake.writes();
    const second = await run(fake);
    expect(second).toMatchObject({ status: 'configured', writes: 0 });
    expect(fake.writes()).toBe(writesAfterFirst);
    expect(fake.rules).toHaveLength(1);
  });

  it('repoints an existing rule for the address instead of adding a duplicate', async () => {
    const fake = new FakeCloudflare();
    fake.rules.push({
      id: 'rule-old',
      name: 'old',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'agent@mail.fixture.example' }],
      actions: [{ type: 'worker', value: ['some-other-worker'] }],
    });

    await run(fake);

    expect(fake.rules).toHaveLength(1);
    expect(fake.rules[0]).toMatchObject({
      id: 'rule-old',
      actions: [{ type: 'worker', value: [WORKER] }],
    });
  });

  it('finds and repoints its rule when the zone has more rules than one page', async () => {
    const fake = new FakeCloudflare();
    // One full page of unrelated rules (the deploy reads 50 per page), then SAM's own rule.
    for (let index = 0; index < 50; index += 1) {
      fake.rules.push({
        id: `other-${index}`,
        name: `forward ${index}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: `person${index}@fixture.example` }],
        actions: [{ type: 'forward', value: [`person${index}@elsewhere.example`] }],
      });
    }
    fake.rules.push({
      id: 'rule-sam',
      name: 'SAM agent email',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'agent@mail.fixture.example' }],
      actions: [{ type: 'worker', value: ['some-other-worker'] }],
    });

    await run(fake);

    expect(fake.rules).toHaveLength(51);
    expect(fake.rules.at(-1)).toMatchObject({
      id: 'rule-sam',
      actions: [{ type: 'worker', value: [WORKER] }],
    });
    expect(fake.calls).toContainEqual({
      method: 'GET',
      path: `/zones/${ZONE}/email/routing/rules?page=2&per_page=50`,
    });
  });

  it('fails the deploy if enabling the subdomain changed pre-existing apex MX records', async () => {
    const fake = new FakeCloudflare();
    fake.routing.enabled = true;
    fake.dns.push({
      type: 'MX',
      name: 'fixture.example',
      content: 'route1.mx.cloudflare.net',
      priority: 13,
    });
    fake.onEnableSubdomain = (state) => {
      state.dns = state.dns.filter((r) => r.name !== 'fixture.example');
    };

    await expect(run(fake)).rejects.toThrow(/changed the MX\/SPF records of fixture\.example/);
  });

  it('refuses to write a sending DNS record outside the agent email subdomain', async () => {
    const fake = new FakeCloudflare();
    fake.sending.push({ tag: 'tag-apex', name: 'mail.fixture.example', enabled: true });
    fake.sendingDns['tag-apex'] = [
      { type: 'TXT', name: '_dmarc.fixture.example', content: 'v=DMARC1; p=reject' },
    ];

    await expect(run(fake)).rejects.toThrow(/outside mail\.fixture\.example/);
    expect(fake.dns.some((r) => r.name === '_dmarc.fixture.example')).toBe(false);
  });

  it('reports Cloudflare mail records added to an apex that had none', async () => {
    const fake = new FakeCloudflare();
    fake.onEnableSubdomain = (state) => {
      state.dns.push(
        { type: 'MX', name: 'fixture.example', content: 'route1.mx.cloudflare.net', priority: 13 },
        {
          type: 'TXT',
          name: 'fixture.example',
          content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
        }
      );
    };

    await expect(run(fake)).resolves.toMatchObject({
      status: 'configured',
      apexMailRecordsAdded: [
        'MX route1.mx.cloudflare.net',
        'TXT v=spf1 include:_spf.mx.cloudflare.net ~all',
      ],
    });
  });

  it('fails the deploy if a non-Cloudflare mail record appears on an apex that had none', async () => {
    const fake = new FakeCloudflare();
    fake.onEnableSubdomain = (state) => {
      state.dns.push({ type: 'MX', name: 'fixture.example', content: 'mx.evil.test', priority: 1 });
    };

    await expect(run(fake)).rejects.toThrow(/added non-Cloudflare mail records/);
  });

  it('fails the deploy if an apex with mail records gains another one', async () => {
    const fake = new FakeCloudflare();
    // SPF only: this apex sends mail elsewhere but has no MX, so the skip guard lets it through.
    fake.dns.push({
      type: 'TXT',
      name: 'fixture.example',
      content: '"v=spf1 include:amazonses.com ~all"',
    });
    fake.onEnableSubdomain = (state) => {
      state.dns.push({
        type: 'TXT',
        name: 'fixture.example',
        content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
      });
    };

    await expect(run(fake)).rejects.toThrow(/changed the MX\/SPF records of fixture\.example/);
  });

  it('ignores apex TXT records that are not SPF', async () => {
    const fake = new FakeCloudflare();
    fake.dns.push({
      type: 'TXT',
      name: 'fixture.example',
      content: '"google-site-verification=x"',
    });
    fake.onEnableSubdomain = (state) => {
      state.dns.push({ type: 'TXT', name: 'fixture.example', content: '"other-verification=y"' });
    };

    await expect(run(fake)).resolves.toMatchObject({
      status: 'configured',
      apexMailRecordsAdded: [],
    });
  });

  it('reports a sending subdomain that is still verifying', async () => {
    const fake = new FakeCloudflare();
    fake.sending.push({ tag: 'tag-pending', name: 'mail.fixture.example', enabled: false });
    fake.sendingDns['tag-pending'] = [];

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured', sendingEnabled: false });
  });
});

describe('agent email marker', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records the configured domain and clears it when email is off', () => {
    dir = mkdtempSync(join(tmpdir(), 'sam-agent-email-'));
    writeAgentEmailMarker(
      {
        status: 'configured',
        domain: 'mail.fixture.example',
        writes: 3,
        apexMailRecordsAdded: [],
        sendingEnabled: true,
      },
      dir
    );
    expect(readAgentEmailMarker(dir)).toBe('mail.fixture.example');

    writeAgentEmailMarker({ status: 'skipped', reason: 'no permission' }, dir);
    expect(readAgentEmailMarker(dir)).toBeNull();
  });
});

describe('agent email address contract', () => {
  it('uses the same subdomain label and local part as the API Worker', () => {
    expect(AGENT_EMAIL_SUBDOMAIN_LABEL).toBe(SHARED_SUBDOMAIN_LABEL);
    expect(AGENT_EMAIL_LOCAL_PART).toBe(SHARED_LOCAL_PART);
  });
});
