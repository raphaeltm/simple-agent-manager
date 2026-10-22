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
  sending: Array<{ tag: string; name: string; enabled?: boolean }> = [];
  sendingDns: Record<string, DnsRecord[]> = {};
  /** Whether Cloudflare finishes verifying a sending subdomain once its records exist. */
  sendingVerifies = true;
  /** Test hook: a side effect of onboarding a sending subdomain (e.g. on the apex). */
  onSendingSubdomainCreated: ((fake: FakeCloudflare) => void) | null = null;
  /** Test hook: a side effect of turning routing on for a subdomain (e.g. on the apex). */
  onSubdomainRoutingEnabled: ((fake: FakeCloudflare) => void) | null = null;
  /** Whether the routing records show up as soon as routing is turned on for a subdomain. */
  routingRecordsAppear = true;
  calls: Array<{ method: HttpMethod; path: string }> = [];

  /** What turning routing on for subdomain `name` leaves behind (dashboard or API). */
  enableSubdomainRouting(name = 'mail.fixture.example'): this {
    for (const [priority, host] of [
      [13, 'route1'],
      [86, 'route2'],
      [24, 'route3'],
    ] as const) {
      this.dns.push({ type: 'MX', name, content: `${host}.mx.cloudflare.net`, priority });
    }
    this.dns.push({ type: 'TXT', name, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
    return this;
  }

  apexMailRecords(): DnsRecord[] {
    return this.dns.filter(
      (record) =>
        record.name === this.zoneName &&
        (record.type === 'MX' || record.content.replace(/"/g, '').startsWith('v=spf1'))
    );
  }

  /** Verified once every record Cloudflare asked for exists, like the real check. */
  private sendingView() {
    return this.sending.map((subdomain) => ({
      ...subdomain,
      enabled:
        subdomain.enabled ??
        (this.sendingVerifies &&
          (this.sendingDns[subdomain.tag] ?? []).every((wanted) =>
            this.dns.some(
              (record) =>
                record.type === wanted.type &&
                record.name === wanted.name &&
                record.content === wanted.content
            )
          )),
    }));
  }

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
      // Per Cloudflare support (cloudflare/terraform-provider-cloudflare#5890): no body enables
      // the zone apex, a subdomain `name` configures that subdomain, and the apex as `name` is
      // rejected with 2007.
      const name = (body as { name?: string } | undefined)?.name;
      if (!name) {
        this.routing.enabled = true;
        return this.ok(this.enableSubdomainRouting(this.zoneName).apexMailRecords());
      }
      if (!name.endsWith(`.${this.zoneName}`)) {
        return {
          status: 422,
          body: {
            success: false,
            errors: [
              { code: 2007, message: `Invalid Input: must be a a subdomains of ${this.zoneName}` },
            ],
          },
        };
      }
      if (this.routingRecordsAppear) this.enableSubdomainRouting(name);
      this.onSubdomainRoutingEnabled?.(this);
      return this.ok(this.dns.filter((record) => record.name === name));
    }
    if (path.startsWith(`${zonePrefix}/email/routing/dns`)) {
      throw new Error(`unexpected routing DNS call: ${route}`);
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
    if (route === 'GET /email/sending/subdomains') return this.ok(this.sendingView());
    if (route === 'POST /email/sending/subdomains') {
      const { name } = body as { name: string };
      const tag = `tag-${this.sending.length + 1}`;
      this.sending.push({ tag, name });
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
      this.onSendingSubdomainCreated?.(this);
      return this.ok(this.sendingView().at(-1));
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
    const fake = new FakeCloudflare().enableSubdomainRouting();
    fake.permissions.delete('sending');

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('Email Sending'),
    });
    expect(fake.writes()).toBe(0);
  });

  it('turns Email Routing on for the subdomain by name, never for the zone apex', async () => {
    const fake = new FakeCloudflare();

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });

    expect(fake.calls.filter((call) => call.path.endsWith('/email/routing/dns'))).toEqual([
      { method: 'POST', path: `/zones/${ZONE}/email/routing/dns` },
    ]);
    expect(fake.routing.enabled).toBe(false);
    expect(fake.dns).toContainEqual(
      expect.objectContaining({
        type: 'MX',
        name: 'mail.fixture.example',
        content: 'route1.mx.cloudflare.net',
      })
    );
    expect(fake.apexMailRecords()).toEqual([]);
  });

  it('fails the deploy before configuring anything else if turning routing on changed the apex', async () => {
    const fake = new FakeCloudflare();
    fake.dns.push({ type: 'MX', name: 'fixture.example', content: 'smtp.google.com', priority: 1 });
    fake.onSubdomainRoutingEnabled = (cloudflare) => {
      cloudflare.dns.push({
        type: 'MX',
        name: 'fixture.example',
        content: 'route1.mx.cloudflare.net',
        priority: 13,
      });
    };

    await expect(run(fake)).rejects.toThrow(/MX\/SPF records of fixture\.example changed/);

    expect(fake.rules).toEqual([]);
    expect(fake.sending).toEqual([]);
    expect(fake.routing.support_subaddress).toBe(false);
  });

  it('stays pending, writing no marker, until the routing records are visible', async () => {
    const fake = new FakeCloudflare();
    fake.routingRecordsAppear = false;

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('MX records are not visible yet'),
    });
    expect(fake.rules).toEqual([]);
  });

  it('configures subaddressing, the worker rule and sending, then is idempotent', async () => {
    const fake = new FakeCloudflare();

    const first = await run(fake);

    // Sending verifies once its records exist, which is after the subdomain was created as
    // unverified: only a read taken after the records were written sees it enabled.
    expect(first).toMatchObject({ status: 'configured', domain: 'mail.fixture.example' });
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
    expect(fake.apexMailRecords()).toEqual([]);

    const writesAfterFirst = fake.writes();
    const second = await run(fake);
    expect(second).toMatchObject({ status: 'configured', writes: 0 });
    expect(fake.writes()).toBe(writesAfterFirst);
    expect(fake.rules).toHaveLength(1);
  });

  it.each([
    ['no mail records', []],
    [
      'only an SPF record',
      [{ type: 'TXT', name: 'fixture.example', content: '"v=spf1 include:amazonses.com ~all"' }],
    ],
    [
      'Google Workspace mail',
      [
        { type: 'MX', name: 'fixture.example', content: 'smtp.google.com', priority: 1 },
        { type: 'TXT', name: 'fixture.example', content: '"v=spf1 include:_spf.google.com ~all"' },
      ],
    ],
    [
      'Cloudflare Email Routing',
      [
        { type: 'MX', name: 'fixture.example', content: 'route1.mx.cloudflare.net', priority: 13 },
        {
          type: 'TXT',
          name: 'fixture.example',
          content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
        },
      ],
    ],
  ] as Array<[string, DnsRecord[]]>)(
    'leaves an apex with %s exactly as it was',
    async (_case, apexRecords) => {
      const fake = new FakeCloudflare();
      fake.dns.push(...apexRecords.map((record) => ({ ...record })));

      await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });

      expect(fake.apexMailRecords()).toEqual(apexRecords);
    }
  );

  it('repoints an existing rule for the address instead of adding a duplicate', async () => {
    const fake = new FakeCloudflare().enableSubdomainRouting();
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
    const fake = new FakeCloudflare().enableSubdomainRouting();
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

  it.each([
    [
      'gains a record on an empty apex',
      [] as DnsRecord[],
      (fake: FakeCloudflare) =>
        fake.dns.push({
          type: 'MX',
          name: 'fixture.example',
          content: 'route1.mx.cloudflare.net',
          priority: 13,
        }),
    ],
    [
      'gains a second SPF record',
      [{ type: 'TXT', name: 'fixture.example', content: '"v=spf1 include:amazonses.com ~all"' }],
      (fake: FakeCloudflare) =>
        fake.dns.push({
          type: 'TXT',
          name: 'fixture.example',
          content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
        }),
    ],
    [
      'loses its MX record',
      [{ type: 'MX', name: 'fixture.example', content: 'smtp.google.com', priority: 1 }],
      (fake: FakeCloudflare) => {
        fake.dns = fake.dns.filter((record) => record.name !== 'fixture.example');
      },
    ],
  ] as Array<[string, DnsRecord[], (fake: FakeCloudflare) => void]>)(
    'fails the deploy if the apex %s during setup',
    async (_case, apexRecords, sideEffect) => {
      const fake = new FakeCloudflare().enableSubdomainRouting();
      fake.dns.push(...apexRecords);
      fake.onSendingSubdomainCreated = sideEffect;

      await expect(run(fake)).rejects.toThrow(/MX\/SPF records of fixture\.example changed/);
    }
  );

  it('refuses to write a sending DNS record outside the agent email subdomain', async () => {
    const fake = new FakeCloudflare().enableSubdomainRouting();
    fake.sending.push({ tag: 'tag-apex', name: 'mail.fixture.example' });
    fake.sendingDns['tag-apex'] = [
      { type: 'TXT', name: '_dmarc.fixture.example', content: 'v=DMARC1; p=reject' },
    ];

    await expect(run(fake)).rejects.toThrow(/outside mail\.fixture\.example/);
    expect(fake.dns.some((r) => r.name === '_dmarc.fixture.example')).toBe(false);
  });

  it('stays pending, with sending set up, while Cloudflare is still verifying it', async () => {
    const fake = new FakeCloudflare().enableSubdomainRouting();
    fake.sendingVerifies = false;

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'pending',
      domain: 'mail.fixture.example',
      reason: expect.stringContaining('still verifying'),
    });
    expect(fake.rules).toHaveLength(1);
    expect(fake.sending.map((s) => s.name)).toEqual(['mail.fixture.example']);

    // The next deploy after verification turns it on.
    fake.sendingVerifies = true;
    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });
  });
});

describe('agent email marker', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records the domain only when agent email is fully configured', () => {
    dir = mkdtempSync(join(tmpdir(), 'sam-agent-email-'));
    writeAgentEmailMarker({ status: 'configured', domain: 'mail.fixture.example', writes: 3 }, dir);
    expect(readAgentEmailMarker(dir)).toBe('mail.fixture.example');

    writeAgentEmailMarker(
      { status: 'pending', domain: 'mail.fixture.example', writes: 0, reason: 'verifying' },
      dir
    );
    expect(readAgentEmailMarker(dir)).toBeNull();

    writeAgentEmailMarker({ status: 'configured', domain: 'mail.fixture.example', writes: 0 }, dir);
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
