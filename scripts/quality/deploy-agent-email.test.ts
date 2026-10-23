import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_EMAIL_SUBDOMAIN_LABEL as SHARED_SUBDOMAIN_LABEL } from '../../packages/shared/src/constants/agent-email';
import {
  type CloudflareRequest,
  type CloudflareResponse,
  type HttpMethod,
  toEnvelope,
} from '../deploy/cloudflare-rest';
import {
  AGENT_EMAIL_SUBDOMAIN_LABEL,
  configureAgentEmail,
  type DnsRecord,
  readAgentEmailMarker,
  writeAgentEmailMarker,
} from '../deploy/configure-agent-email';

const ZONE = 'zone-1';

type Permission = 'zoneSettings' | 'routingRules' | 'sending';

/**
 * Strict in-memory Cloudflare peer. It accepts only the documented request shapes the real API
 * takes, rejects unknown routes, and applies writes to its state so that a second run can prove
 * idempotency. Email Routing is read-only here: the deploy step may probe it, and any write
 * throws, because turning routing on belongs to the admin setup.
 */
class FakeCloudflare {
  permissions = new Set<Permission>(['zoneSettings', 'routingRules', 'sending']);
  zoneName = 'fixture.example';
  routing = { enabled: false, support_subaddress: false };
  dns: DnsRecord[] = [];
  sending: Array<{ tag: string; name: string; enabled?: boolean }> = [];
  sendingDns: Record<string, DnsRecord[]> = {};
  /** Whether Cloudflare finishes verifying a sending subdomain once its records exist. */
  sendingVerifies = true;
  /** Test hook: a side effect of onboarding a sending subdomain (e.g. on the apex). */
  onSendingSubdomainCreated: ((fake: FakeCloudflare) => void) | null = null;
  /** Test hook: creating a DNS record at this name fails with this Cloudflare error. */
  dnsCreateError: { name: string; code: number; message: string; status?: number } | null = null;
  /** Test hook: runs as a DNS record create arrives, after the step's own lookup. */
  beforeDnsCreate: ((fake: FakeCloudflare, record: DnsRecord) => void) | null = null;
  calls: Array<{ method: HttpMethod; path: string }> = [];
  /** Most DNS records one page returns, below what `per_page` asks for. */
  dnsPageLimit = Number.POSITIVE_INFINITY;

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

  // Every answer goes through the same parsing a real response does, so a field the parser
  // drops is dropped here too.
  request: CloudflareRequest = async (method, path, body) => {
    this.calls.push({ method, path });
    const response = this.handle(method, path, body);
    return { status: response.status, body: toEnvelope(JSON.parse(JSON.stringify(response.body))) };
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
      const perPage = Math.min(Number(params.get('per_page') ?? '100'), this.dnsPageLimit);
      const matches = this.dns.filter((r) => r.type === type && r.name === name);
      const result = matches.slice(0, perPage);
      return {
        status: 200,
        body: {
          success: true,
          result,
          result_info: { count: result.length, total_count: matches.length },
        },
      };
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
      if (method !== 'GET')
        throw new Error(`the deploy step must not change Email Routing: ${route}`);
      if (!this.permissions.has(path.includes('/rules') ? 'routingRules' : 'zoneSettings'))
        return this.denied();
      if (route === 'GET /email/routing') return this.ok({ name: this.zoneName, ...this.routing });
      if (route === 'GET /email/routing/rules') return this.ok([]);
      throw new Error(`unexpected routing read: ${route}`);
    }
    if (path.startsWith(`${zonePrefix}/email/sending`) && !this.permissions.has('sending')) {
      return this.denied();
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

  writes(): number {
    return this.calls.filter((call) => call.method !== 'GET').length;
  }
}

function run(fake: FakeCloudflare) {
  return configureAgentEmail(fake.request, { zoneId: ZONE, baseDomain: 'fixture.example' });
}

describe('configureAgentEmail (prepare only)', () => {
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

  it('stays off without writing anything when the token cannot use Email Routing rules', async () => {
    // The Worker gets the same token, and the admin setup needs routing access.
    const fake = new FakeCloudflare();
    fake.permissions.delete('routingRules');

    await expect(run(fake)).resolves.toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('Email Routing Rules'),
    });
    expect(fake.writes()).toBe(0);
  });

  it('prepares Email Sending without touching Email Routing, even in a zone new to it', async () => {
    const fake = new FakeCloudflare();

    const outcome = await run(fake);

    expect(outcome).toEqual({
      status: 'prepared',
      domain: 'agents.fixture.example',
      writes: expect.any(Number),
      sendingVerified: true,
    });
    expect(fake.routing).toEqual({ enabled: false, support_subaddress: false });
    expect(
      fake.calls.filter((call) => call.method !== 'GET' && call.path.includes('/email/routing'))
    ).toEqual([]);
    expect(fake.apexMailRecords()).toEqual([]);
    expect(fake.sending.map((subdomain) => subdomain.name)).toEqual(['agents.fixture.example']);
    for (const record of fake.sendingDns['tag-1']!) {
      expect(fake.dns).toContainEqual(
        expect.objectContaining({ type: record.type, name: record.name })
      );
    }
  });

  it('prepares while Cloudflare still verifies the sending records, so the binding can ship', async () => {
    // The sender is checked when mail is sent (E_SENDER_NOT_VERIFIED), not at deploy.
    const fake = new FakeCloudflare();
    fake.sendingVerifies = false;

    await expect(run(fake)).resolves.toMatchObject({
      status: 'prepared',
      sendingVerified: false,
    });
  });

  it('is idempotent', async () => {
    const fake = new FakeCloudflare();
    await run(fake);
    const writesAfterFirst = fake.writes();

    await expect(run(fake)).resolves.toMatchObject({ status: 'prepared', writes: 0 });
    expect(fake.writes()).toBe(writesAfterFirst);
    expect(fake.sending).toHaveLength(1);
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

      await expect(run(fake)).resolves.toMatchObject({ status: 'prepared' });

      expect(fake.apexMailRecords()).toEqual(apexRecords);
    }
  );

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
      const fake = new FakeCloudflare();
      fake.dns.push(...apexRecords);
      fake.onSendingSubdomainCreated = sideEffect;

      await expect(run(fake)).rejects.toThrow(/MX\/SPF records of fixture\.example changed/);
    }
  );

  it('refuses to write a sending DNS record outside the agent email subdomain', async () => {
    const fake = new FakeCloudflare();
    fake.sending.push({ tag: 'tag-apex', name: 'agents.fixture.example' });
    fake.sendingDns['tag-apex'] = [
      { type: 'TXT', name: '_dmarc.fixture.example', content: 'v=DMARC1; p=reject' },
    ];

    await expect(run(fake)).rejects.toThrow(/outside agents\.fixture\.example/);
    expect(fake.dns.some((r) => r.name === '_dmarc.fixture.example')).toBe(false);
  });

  it('recognises sending records Cloudflare created itself, even long TXT values split into strings', async () => {
    const fake = new FakeCloudflare();
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

    await expect(run(fake)).resolves.toMatchObject({ status: 'prepared' });

    expect(
      fake.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/dns_records'))
    ).toEqual([]);
  });

  it('carries on when an identical sending record appears between its lookup and its create', async () => {
    const fake = new FakeCloudflare();
    let raced = false;
    fake.beforeDnsCreate = (cloudflare, record) => {
      // Another run, or Cloudflare itself, creates the exact record after the step looked.
      if (raced || record.name !== '_dmarc.agents.fixture.example') return;
      raced = true;
      cloudflare.dns.push({ type: record.type, name: record.name, content: record.content });
    };

    await expect(run(fake)).resolves.toMatchObject({ status: 'prepared' });

    expect(raced).toBe(true);
    expect(
      fake.dns.filter((record) => record.name === '_dmarc.agents.fixture.example')
    ).toHaveLength(1);
  });

  it('compares TXT values byte for byte, so a DKIM key differing only in case is not taken as present', async () => {
    const fake = new FakeCloudflare();
    const dkimName = 'cf-bounce._domainkey.agents.fixture.example';
    fake.onSendingSubdomainCreated = (cloudflare) => {
      const dkim = Object.values(cloudflare.sendingDns)
        .flat()
        .find((record) => record.name === dkimName)!;
      cloudflare.dns.push({ ...dkim, content: `"${dkim.content.toLowerCase()}"` });
    };

    await expect(run(fake)).resolves.toMatchObject({ status: 'prepared', sendingVerified: true });

    expect(fake.dns.filter((record) => record.name === dkimName).map((r) => r.content)).toContain(
      'v=DKIM1; k=rsa; p=MIIB'
    );
  });

  it('still fails the deploy when another record already holds a sending record name', async () => {
    const fake = new FakeCloudflare();
    fake.dnsCreateError = {
      name: '_dmarc.agents.fixture.example',
      code: 81053,
      message: 'An A, AAAA, or CNAME record with that host already exists.',
    };

    await expect(run(fake)).rejects.toThrow(/81053/);
  });

  it('still fails the deploy when creating a sending record fails for another reason', async () => {
    const fake = new FakeCloudflare();
    fake.dnsCreateError = {
      name: '_dmarc.agents.fixture.example',
      code: 10000,
      message: 'Authentication error',
      status: 403,
    };

    await expect(run(fake)).rejects.toThrow(/HTTP 403: 10000 Authentication error/);
  });
});

describe('agent email marker', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records the domain whenever Email Sending is prepared, verified or not', () => {
    dir = mkdtempSync(join(tmpdir(), 'sam-agent-email-'));
    writeAgentEmailMarker(
      { status: 'prepared', domain: 'agents.fixture.example', writes: 3, sendingVerified: false },
      dir
    );
    expect(readAgentEmailMarker(dir)).toBe('agents.fixture.example');

    writeAgentEmailMarker({ status: 'skipped', reason: 'no permission' }, dir);
    expect(readAgentEmailMarker(dir)).toBeNull();
  });
});

describe('agent email DNS listing', () => {
  it('fails rather than compare a listing Cloudflare reports as partial', async () => {
    const fake = new FakeCloudflare();
    fake.dnsPageLimit = 1;
    fake.dns.push(
      { type: 'TXT', name: 'fixture.example', content: '"google-site-verification=abc123"' },
      { type: 'TXT', name: 'fixture.example', content: '"v=spf1 include:_spf.google.com ~all"' }
    );
    await expect(run(fake)).rejects.toThrow(
      'Cloudflare listed 1 of 2 TXT records for fixture.example'
    );
    expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('agent email address contract', () => {
  it('uses the same subdomain label as the API Worker', () => {
    expect(AGENT_EMAIL_SUBDOMAIN_LABEL).toBe(SHARED_SUBDOMAIN_LABEL);
  });
});
