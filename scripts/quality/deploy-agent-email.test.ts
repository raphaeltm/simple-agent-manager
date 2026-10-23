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
  /** Test hook: creating a DNS record at this name fails with this Cloudflare error. */
  dnsCreateError: { name: string; code: number; message: string; status?: number } | null = null;
  /** Test hook: runs as a DNS record create arrives, after the step's own lookup. */
  beforeDnsCreate: ((fake: FakeCloudflare, record: DnsRecord) => void) | null = null;
  calls: Array<{ method: HttpMethod; path: string }> = [];

  /**
   * Email Routing was turned on in this zone before. The apex keeps whatever records the test
   * gives it: the SPF record Cloudflare adds there is an ordinary record an admin can remove.
   */
  useEmailRouting(): this {
    this.routing.enabled = true;
    return this;
  }

  /** What turning routing on for subdomain `name` leaves behind (dashboard or API). */
  enableSubdomainRouting(name = 'agents.fixture.example'): this {
    this.routing.enabled = true;
    this.addRoutingMx(name);
    this.dns.push({ type: 'TXT', name, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
    return this;
  }

  private addRoutingMx(name: string): void {
    for (const [priority, host] of [
      [13, 'route1'],
      [86, 'route2'],
      [24, 'route3'],
    ] as const) {
      this.dns.push({ type: 'MX', name, content: `${host}.mx.cloudflare.net`, priority });
    }
  }

  /**
   * The first time Email Routing is turned on in a zone, whichever name the request gives,
   * Cloudflare turns it on for the whole zone and adds its SPF record and a locked DKIM key at
   * the apex (seen on staging, deploy run 39866499256). What it does to an apex that already
   * has an SPF record is unverified; this fake adds a second one.
   */
  private enableZone(): void {
    if (this.routing.enabled) return;
    this.routing.enabled = true;
    this.dns.push({
      type: 'TXT',
      name: this.zoneName,
      content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
    });
    this.dns.push({
      type: 'TXT',
      name: `cf2024-1._domainkey.${this.zoneName}`,
      content: '"v=DKIM1; h=sha256; k=rsa; p=MIIB"',
    });
  }

  /**
   * How Cloudflare compares record content, as far as staging showed: a TXT value stored as
   * several quoted strings equals the same value joined (deploy run 39882259188). Nothing else
   * is folded, so spacing and case still make values differ.
   */
  static sameContent(a: string, b: string): boolean {
    const payload = (value: string) => {
      const quoted = value.trim().match(/"(?:[^"\\]|\\.)*"/g);
      return quoted ? quoted.map((chunk) => chunk.slice(1, -1)).join('') : value.trim();
    };
    return payload(a) === payload(b);
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
                FakeCloudflare.sameContent(record.content, wanted.content)
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
      this.beforeDnsCreate?.(this, record);
      const failure = this.dnsCreateError;
      if (failure && failure.name === record.name) {
        return {
          status: failure.status ?? 400,
          body: { success: false, errors: [{ code: failure.code, message: failure.message }] },
        };
      }
      const identical = this.dns.some(
        (existing) =>
          existing.type === record.type &&
          existing.name === record.name &&
          FakeCloudflare.sameContent(existing.content, record.content)
      );
      if (identical) {
        return {
          status: 400,
          body: {
            success: false,
            errors: [{ code: 81058, message: 'An identical record already exists.' }],
          },
        };
      }
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
        this.enableZone();
        this.addRoutingMx(this.zoneName);
        return this.ok(this.apexMailRecords());
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
      this.enableZone();
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
      matchers: [{ type: 'literal', field: 'to', value: expect.stringMatching(/^agent@agents\./) }],
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
    const fake = new FakeCloudflare().useEmailRouting();

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });

    expect(fake.calls.filter((call) => call.path.endsWith('/email/routing/dns'))).toEqual([
      { method: 'POST', path: `/zones/${ZONE}/email/routing/dns` },
    ]);
    expect(fake.dns).toContainEqual(
      expect.objectContaining({
        type: 'MX',
        name: 'agents.fixture.example',
        content: 'route1.mx.cloudflare.net',
      })
    );
    expect(fake.apexMailRecords()).toEqual([]);
  });

  // Known preview limitation, pending the decision recorded as open question 5 in
  // tasks/active/2026-10-22-agent-email-prototype.md: accept or merge the records Cloudflare adds
  // to the apex, or keep agent email off until an admin opts in. Until then the apex check stops
  // the first deploy in a zone new to Email Routing, after Cloudflare has added them.
  it('for now, fails the first deploy in a zone new to Email Routing, then completes on the next', async () => {
    const fake = new FakeCloudflare();

    await expect(run(fake)).rejects.toThrow(/MX\/SPF records of fixture\.example changed/);

    expect(fake.apexMailRecords()).toEqual([
      {
        type: 'TXT',
        name: 'fixture.example',
        content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
      },
    ]);
    expect(fake.rules).toEqual([]);
    expect(fake.sending).toEqual([]);

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });
    expect(fake.apexMailRecords()).toHaveLength(1);
  });

  it('fails the deploy before configuring anything else if turning routing on changed the apex', async () => {
    const fake = new FakeCloudflare().useEmailRouting();
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
    const fake = new FakeCloudflare().useEmailRouting();
    fake.routingRecordsAppear = false;

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('MX records are not visible yet'),
    });
    expect(fake.rules).toEqual([]);
  });

  it('configures subaddressing, the worker rule and sending, then is idempotent', async () => {
    const fake = new FakeCloudflare().useEmailRouting();

    const first = await run(fake);

    // Sending verifies once its records exist, which is after the subdomain was created as
    // unverified: only a read taken after the records were written sees it enabled.
    expect(first).toMatchObject({ status: 'configured', domain: 'agents.fixture.example' });
    expect(fake.routing.support_subaddress).toBe(true);
    expect(fake.rules).toEqual([
      {
        id: 'rule-1',
        name: 'SAM agent email',
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: 'agent@agents.fixture.example' }],
        actions: [{ type: 'worker', value: [WORKER] }],
      },
    ]);
    expect(fake.sending.map((s) => s.name)).toEqual(['agents.fixture.example']);
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
    'leaves an apex with %s exactly as it was, in a zone already using Email Routing',
    async (_case, apexRecords) => {
      const fake = new FakeCloudflare().useEmailRouting();
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
      matchers: [{ type: 'literal', field: 'to', value: 'agent@agents.fixture.example' }],
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
      matchers: [{ type: 'literal', field: 'to', value: 'agent@agents.fixture.example' }],
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
    fake.sending.push({ tag: 'tag-apex', name: 'agents.fixture.example' });
    fake.sendingDns['tag-apex'] = [
      { type: 'TXT', name: '_dmarc.fixture.example', content: 'v=DMARC1; p=reject' },
    ];

    await expect(run(fake)).rejects.toThrow(/outside agents\.fixture\.example/);
    expect(fake.dns.some((r) => r.name === '_dmarc.fixture.example')).toBe(false);
  });

  it('recognises sending records Cloudflare created itself, even long TXT values split into strings', async () => {
    const fake = new FakeCloudflare().useEmailRouting();
    fake.onSendingSubdomainCreated = (cloudflare) => {
      for (const records of Object.values(cloudflare.sendingDns)) {
        for (const record of records) {
          // Cloudflare stores a long TXT value as several quoted strings.
          const content =
            record.type === 'TXT'
              ? `"${record.content.slice(0, 12)}" "${record.content.slice(12)}"`
              : record.content;
          cloudflare.dns.push({ ...record, content });
        }
      }
    };

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });

    expect(
      fake.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dns_records'))
    ).toEqual([]);
  });

  it('carries on when an identical sending record appears between its lookup and its create', async () => {
    const fake = new FakeCloudflare().useEmailRouting();
    let raced = false;
    fake.beforeDnsCreate = (cloudflare, record) => {
      // Another run, or Cloudflare itself, creates the exact record after the step looked.
      if (raced || record.name !== '_dmarc.agents.fixture.example') return;
      raced = true;
      cloudflare.dns.push({ type: record.type, name: record.name, content: record.content });
    };

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });

    expect(raced).toBe(true);
    expect(
      fake.dns.filter((record) => record.name === '_dmarc.agents.fixture.example')
    ).toHaveLength(1);
  });

  it('compares TXT values byte for byte, so a DKIM key differing only in case is not taken as present', async () => {
    const fake = new FakeCloudflare().useEmailRouting();
    const dkimName = 'cf-bounce._domainkey.agents.fixture.example';
    fake.onSendingSubdomainCreated = (cloudflare) => {
      const dkim = Object.values(cloudflare.sendingDns)
        .flat()
        .find((record) => record.name === dkimName)!;
      cloudflare.dns.push({ ...dkim, content: `"${dkim.content.toLowerCase()}"` });
    };

    await expect(run(fake)).resolves.toMatchObject({ status: 'configured' });

    expect(fake.dns.filter((record) => record.name === dkimName).map((r) => r.content)).toContain(
      'v=DKIM1; k=rsa; p=MIIB'
    );
  });

  it('still fails the deploy when another record already holds a sending record name', async () => {
    const fake = new FakeCloudflare().useEmailRouting();
    fake.dnsCreateError = {
      name: '_dmarc.agents.fixture.example',
      code: 81053,
      message: 'An A, AAAA, or CNAME record with that host already exists.',
    };

    await expect(run(fake)).rejects.toThrow(/81053/);
  });

  it('still fails the deploy when creating a sending record fails for another reason', async () => {
    const fake = new FakeCloudflare().useEmailRouting();
    fake.dnsCreateError = {
      name: '_dmarc.agents.fixture.example',
      code: 10000,
      message: 'Authentication error',
      status: 403,
    };

    await expect(run(fake)).rejects.toThrow(/HTTP 403: 10000 Authentication error/);
  });

  it('stays pending, with sending set up, while Cloudflare is still verifying it', async () => {
    const fake = new FakeCloudflare().enableSubdomainRouting();
    fake.sendingVerifies = false;

    const outcome = await run(fake);

    expect(outcome).toMatchObject({
      status: 'pending',
      domain: 'agents.fixture.example',
      reason: expect.stringContaining('still verifying'),
    });
    expect(fake.rules).toHaveLength(1);
    expect(fake.sending.map((s) => s.name)).toEqual(['agents.fixture.example']);

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
    writeAgentEmailMarker(
      { status: 'configured', domain: 'agents.fixture.example', writes: 3 },
      dir
    );
    expect(readAgentEmailMarker(dir)).toBe('agents.fixture.example');

    writeAgentEmailMarker(
      { status: 'pending', domain: 'agents.fixture.example', writes: 0, reason: 'verifying' },
      dir
    );
    expect(readAgentEmailMarker(dir)).toBeNull();

    writeAgentEmailMarker(
      { status: 'configured', domain: 'agents.fixture.example', writes: 0 },
      dir
    );
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
