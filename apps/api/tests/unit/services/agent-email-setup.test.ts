/**
 * The agent email admin setup against a fake Cloudflare zone (DNS, Email Routing, Email Sending)
 * and a real SQLite database for the on-switch record. Each case starts from a zone shape seen
 * in practice: staging (routing already on for the subdomain), a zone that uses Email Routing
 * elsewhere, a zone new to Email Routing, and zones whose main domain has its own mail.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { CloudflareEmailApiError } from '../../../src/services/agent-email/cloudflare-email-api';
import {
  AGENT_EMAIL_RULE_NAME,
  AgentEmailMainDomainChangedError,
  AgentEmailSetupRefusedError,
  CLOUDFLARE_ROUTING_SPF,
  planAgentEmailSetup,
  runAgentEmailSetup,
} from '../../../src/services/agent-email/setup';
import {
  AGENT_EMAIL_SETUP_KEY,
  agentEmailConfig,
  isAgentEmailOn,
} from '../../../src/services/agent-email/setup-state';
import {
  cloudflareError,
  cloudflareRoutingFirstUse,
  cloudflareRoutingMx,
  FAKE_CF_ZONE_ID,
  fakeCloudflareEmail,
  type FakeCloudflareEmailOptions,
} from '../../helpers/fake-cloudflare-email';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const MAIN = 'fixture.example';
const DOMAIN = `agents.${MAIN}`;
const WORKER = 'sam-api-fixture';
const VERIFIED = [{ name: DOMAIN, enabled: true }];
const DESIRED_RULE = {
  name: AGENT_EMAIL_RULE_NAME,
  enabled: true,
  matchers: [{ type: 'literal', field: 'to', value: `agent@${DOMAIN}` }],
  actions: [{ type: 'worker', value: [WORKER] }],
};

/** Staging on 2026-10-23: routing on for the subdomain only, subaddressing on. */
const STAGING_LIKE: FakeCloudflareEmailOptions = {
  routing: { enabled: true, support_subaddress: true },
  dns: [...cloudflareRoutingFirstUse(MAIN), ...cloudflareRoutingMx(DOMAIN)],
  sending: VERIFIED,
};

/** A zone that has never used Email Routing, with no mail on its main domain. */
const NEW_ZONE: FakeCloudflareEmailOptions = {
  dns: [{ type: 'A', name: MAIN, content: '192.0.2.10' }],
  sending: VERIFIED,
};

describe('agent email admin setup', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: MAIN,
      CF_ZONE_ID: FAKE_CF_ZONE_ID,
      CF_API_TOKEN: 'cf-token',
      AGENT_EMAIL: { send: vi.fn() } as unknown as SendEmail,
      AGENT_EMAIL_WORKER_NAME: WORKER,
    } as Env;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  function cloudflare(options: FakeCloudflareEmailOptions) {
    const fake = fakeCloudflareEmail(options);
    vi.stubGlobal('fetch', fake.fetchMock);
    return fake;
  }

  function storedRecord(): unknown {
    const row = sqlite
      .prepare('SELECT value, updated_by AS updatedBy FROM platform_settings WHERE key = ?')
      .get(AGENT_EMAIL_SETUP_KEY) as { value: string; updatedBy: string } | undefined;
    return row ? { ...JSON.parse(row.value), updatedBy: row.updatedBy } : null;
  }

  const run = (allowMainDomainChanges = false) =>
    runAgentEmailSetup(env, { allowMainDomainChanges, userId: 'admin-1' });

  describe('plan', () => {
    it('is unavailable until the deploy prepared agent email, without calling Cloudflare', async () => {
      const fake = cloudflare(STAGING_LIKE);
      const withoutBinding = await planAgentEmailSetup({ ...env, AGENT_EMAIL: undefined });
      expect(withoutBinding.state).toBe('unavailable');
      expect(withoutBinding.reason).toContain('has not prepared agent email');

      const withoutWorkerName = await planAgentEmailSetup({
        ...env,
        AGENT_EMAIL_WORKER_NAME: undefined,
      });
      expect(withoutWorkerName).toMatchObject({ state: 'unavailable', domain: DOMAIN });
      expect(withoutWorkerName.reason).toContain('Deploy again');

      const withoutBaseDomain = await planAgentEmailSetup({ ...env, BASE_DOMAIN: ' ' });
      expect(withoutBaseDomain.state).toBe('unavailable');
      expect(fake.calls).toEqual([]);
    });

    it('is unavailable while Email Sending has no subdomain for agent email', async () => {
      cloudflare({ ...STAGING_LIKE, sending: [{ name: `other.${MAIN}`, enabled: true }] });
      const plan = await planAgentEmailSetup(env);
      expect(plan).toMatchObject({ state: 'unavailable', domain: DOMAIN, mainDomain: MAIN });
      expect(plan.reason).toContain(`Email Sending is not set up for ${DOMAIN}`);
    });

    it('needs no consent where the zone already uses Email Routing', async () => {
      cloudflare(STAGING_LIKE);
      expect(await planAgentEmailSetup(env)).toEqual({
        state: 'ready',
        domain: DOMAIN,
        mainDomain: MAIN,
        mainDomainChanges: [],
        reason: null,
      });

      cloudflare({
        routing: { enabled: true },
        dns: cloudflareRoutingFirstUse(MAIN),
        sending: VERIFIED,
      });
      expect((await planAgentEmailSetup(env)).state).toBe('ready');
    });

    it('asks to let Cloudflare add its SPF record and DKIM key in a zone new to Email Routing', async () => {
      const fake = cloudflare(NEW_ZONE);
      expect(await planAgentEmailSetup(env)).toEqual({
        state: 'needs_consent',
        domain: DOMAIN,
        mainDomain: MAIN,
        mainDomainChanges: [
          { type: 'TXT', name: MAIN, content: CLOUDFLARE_ROUTING_SPF },
          { type: 'TXT', name: `cf2024-1._domainkey.${MAIN}`, content: null },
        ],
        reason: expect.stringContaining(`${MAIN} has never used Email Routing`),
      });
      expect(fake.writes()).toEqual([]);
    });

    it('refuses a zone new to Email Routing whose main domain has its own MX or SPF records', async () => {
      for (const [label, records, named] of [
        [
          'Google Workspace MX',
          [{ type: 'MX', name: MAIN, content: 'smtp.google.com', priority: 1 }],
          'MX smtp.google.com',
        ],
        [
          'an SPF record alone',
          [{ type: 'TXT', name: MAIN, content: '"v=spf1 include:_spf.google.com ~all"' }],
          'TXT v=spf1 include:_spf.google.com ~all',
        ],
      ] as const) {
        const fake = cloudflare({ ...NEW_ZONE, dns: [...records] });
        const plan = await planAgentEmailSetup(env);
        expect(plan.state, label).toBe('refused');
        expect(plan.reason, label).toContain(named);
        expect(plan.mainDomainChanges, label).toEqual([]);
        await expect(run(true), label).rejects.toBeInstanceOf(AgentEmailSetupRefusedError);
        expect(fake.writes(), label).toEqual([]);
      }
      expect(storedRecord()).toBeNull();
    });

    it('does not count a TXT record that is not SPF as mail', async () => {
      cloudflare({
        ...NEW_ZONE,
        dns: [{ type: 'TXT', name: MAIN, content: '"google-site-verification=abc123"' }],
      });
      expect((await planAgentEmailSetup(env)).state).toBe('needs_consent');
    });

    it('waits while Cloudflare verifies the sending records, and refuses to run meanwhile', async () => {
      for (const options of [STAGING_LIKE, NEW_ZONE]) {
        const fake = cloudflare({ ...options, sending: [{ name: DOMAIN, enabled: false }] });
        const plan = await planAgentEmailSetup(env);
        expect(plan.state).toBe('verifying');
        expect(plan.reason).toContain('still verifying');
        await expect(run(true)).rejects.toBeInstanceOf(AgentEmailSetupRefusedError);
        expect(fake.writes()).toEqual([]);
      }
      expect(storedRecord()).toBeNull();
    });
  });

  describe('run', () => {
    it('turns agent email on where the subdomain already routes, changing nothing on the main domain', async () => {
      const fake = cloudflare(STAGING_LIKE);
      const mainBefore = structuredClone(fake.state.dns.filter((record) => record.name === MAIN));
      expect(await isAgentEmailOn(env)).toBe(false);

      const result = await run();

      expect(result).toEqual({
        state: 'on',
        domain: DOMAIN,
        mainDomain: MAIN,
        mainDomainChanges: [],
        reason: null,
      });
      expect(fake.writes()).toEqual([
        { method: 'POST', path: '/email/routing/rules', body: DESIRED_RULE },
      ]);
      expect(fake.state.dns.filter((record) => record.name === MAIN)).toEqual(mainBefore);
      expect(storedRecord()).toEqual({
        domain: DOMAIN,
        enabledAt: expect.any(String),
        mainDomainChanges: [],
        updatedBy: 'admin-1',
      });
      expect(await isAgentEmailOn(env)).toBe(true);
      expect(await agentEmailConfig(env)).toEqual({ enabled: true, domain: DOMAIN });
    });

    it('turns routing on for the subdomain where the zone uses Email Routing elsewhere', async () => {
      const fake = cloudflare({
        routing: { enabled: true, support_subaddress: true },
        dns: cloudflareRoutingFirstUse(MAIN),
        sending: VERIFIED,
      });
      expect((await run()).state).toBe('on');
      expect(fake.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
        'POST /email/routing/dns',
        'POST /email/routing/rules',
      ]);
      expect(fake.writes()[0]!.body).toEqual({ name: DOMAIN });
      expect(fake.records('MX', DOMAIN)).toHaveLength(3);
    });

    it('changes nothing without consent in a zone new to Email Routing', async () => {
      const fake = cloudflare(NEW_ZONE);
      const refusal = await run(false).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((refusal as Error).message).toBe(
        `Allow the changes to ${MAIN} to turn agent email on.`
      );
      expect(fake.writes()).toEqual([]);
      expect(storedRecord()).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);
    });

    it('with consent, turns routing on by name and the main domain gains only the disclosed records', async () => {
      const fake = cloudflare(NEW_ZONE);
      const disclosed = (await planAgentEmailSetup(env)).mainDomainChanges;

      const result = await run(true);

      expect(result).toMatchObject({ state: 'on', mainDomainChanges: disclosed });
      expect(fake.writes()).toEqual([
        { method: 'POST', path: '/email/routing/dns', body: { name: DOMAIN } },
        { method: 'PATCH', path: '/email/routing', body: { support_subaddress: true } },
        { method: 'POST', path: '/email/routing/rules', body: DESIRED_RULE },
      ]);
      expect(fake.records('TXT', MAIN).map((record) => record.content)).toEqual([
        `"${CLOUDFLARE_ROUTING_SPF}"`,
      ]);
      expect(fake.records('MX', MAIN)).toEqual([]);
      expect(storedRecord()).toMatchObject({ domain: DOMAIN, mainDomainChanges: disclosed });
      expect(await isAgentEmailOn(env)).toBe(true);
    });

    it('accepts a main domain that gains fewer records than disclosed', async () => {
      const fake = cloudflare({ ...NEW_ZONE, firstUseAdds: () => [] });
      expect((await run(true)).state).toBe('on');
      expect(fake.records('TXT', MAIN)).toEqual([]);
    });

    it('stops with agent email off when the main domain gains a record it did not disclose', async () => {
      const error = vi.spyOn(log, 'error');
      const fake = cloudflare({
        ...NEW_ZONE,
        firstUseAdds: (zone) => [
          ...cloudflareRoutingFirstUse(zone),
          { type: 'MX', name: zone, content: 'route1.mx.cloudflare.net', priority: 10 },
        ],
      });

      const failure = await run(true).catch((caught: unknown) => caught);

      expect(failure).toBeInstanceOf(AgentEmailMainDomainChangedError);
      expect((failure as Error).message).toContain('added MX route1.mx.cloudflare.net');
      expect((failure as Error).message).toContain('Agent email is still off');
      expect(error).toHaveBeenCalledWith('agent_email.setup_main_domain_changed', {
        mainDomain: MAIN,
        added: ['MX route1.mx.cloudflare.net'],
        removed: [],
      });
      expect(fake.writes().map((call) => call.path)).toEqual(['/email/routing/dns']);
      expect(storedRecord()).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);

      // As the error says: running again turns it on with the records as they are, without
      // asking Cloudflare to turn routing on a second time.
      expect((await run()).state).toBe('on');
      expect(fake.writes().filter((call) => call.path === '/email/routing/dns')).toHaveLength(1);
    });

    it('stops with agent email off when the main domain loses a record', async () => {
      const fake = cloudflare({
        routing: { enabled: true, support_subaddress: true },
        dns: cloudflareRoutingFirstUse(MAIN),
        sending: VERIFIED,
        onEnable: (dns) => {
          const spf = dns.findIndex((record) => record.type === 'TXT' && record.name === MAIN);
          dns.splice(spf, 1);
        },
      });
      const failure = await run().catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(AgentEmailMainDomainChangedError);
      expect((failure as Error).message).toContain(`removed TXT ${CLOUDFLARE_ROUTING_SPF}`);
      expect(fake.writes().map((call) => call.path)).toEqual(['/email/routing/dns']);
      expect(storedRecord()).toBeNull();
    });

    it('reports pending until the subdomain MX records show, then finishes without new consent', async () => {
      const fake = cloudflare({ ...NEW_ZONE, mxVisibleAfterEnable: false });

      const first = await run(true);
      expect(first.state).toBe('pending');
      expect(first.reason).toContain('Run the setup again in a minute');
      expect(storedRecord()).toBeNull();

      // Still not visible: the zone now uses Email Routing, so no consent is needed, and the
      // root domain's new SPF record is not a surprise the second time.
      expect(await planAgentEmailSetup(env)).toMatchObject({ state: 'ready' });
      expect((await run()).state).toBe('pending');

      fake.state.dns.push(
        ...cloudflareRoutingMx(DOMAIN).map((record, index) => ({ id: `mx-${index}`, ...record }))
      );
      expect((await run()).state).toBe('on');
      expect(fake.writes().filter((call) => call.path === '/email/routing/dns')).toHaveLength(2);
      expect(fake.records('TXT', MAIN)).toHaveLength(1);
      expect(await isAgentEmailOn(env)).toBe(true);
    });

    it('does nothing once agent email is on', async () => {
      const fake = cloudflare(STAGING_LIKE);
      await run();
      const callsAfterSetup = fake.calls.length;

      expect((await run()).state).toBe('on');
      expect((await planAgentEmailSetup(env)).state).toBe('on');
      expect(fake.calls).toHaveLength(callsAfterSetup);
    });

    it('points an existing agent@ rule at this Worker instead of adding a second one', async () => {
      for (const existing of [
        { enabled: true, actions: [{ type: 'worker', value: ['old-worker'] }] },
        { enabled: false, actions: [{ type: 'worker', value: [WORKER] }] },
        { enabled: true, actions: [{ type: 'forward', value: ['ops@example.com'] }] },
        // Also copies mail elsewhere.
        {
          enabled: true,
          actions: [
            { type: 'worker', value: [WORKER] },
            { type: 'forward', value: ['ops@example.com'] },
          ],
        },
        { enabled: true, actions: [{ type: 'worker', value: [WORKER, 'other-worker'] }] },
      ]) {
        const fake = cloudflare({
          ...STAGING_LIKE,
          rules: [
            {
              id: 'rule-agent',
              name: 'Old rule',
              matchers: [{ type: 'literal', field: 'to', value: `Agent@${DOMAIN}` }],
              ...existing,
            },
          ],
        });
        sqlite.prepare('DELETE FROM platform_settings').run();
        env = { ...env, DATABASE: createSqliteD1(sqlite) };

        expect((await run()).state).toBe('on');
        expect(fake.writes()).toEqual([
          { method: 'PUT', path: '/email/routing/rules/rule-agent', body: DESIRED_RULE },
        ]);
        expect(fake.state.rules).toHaveLength(1);
      }
    });

    it('turns subaddressing back on where the subdomain routes but subaddressing is off', async () => {
      const fake = cloudflare({
        ...STAGING_LIKE,
        routing: { enabled: true, support_subaddress: false },
      });
      expect((await run()).state).toBe('on');
      expect(fake.writes()).toEqual([
        { method: 'PATCH', path: '/email/routing', body: { support_subaddress: true } },
        { method: 'POST', path: '/email/routing/rules', body: DESIRED_RULE },
      ]);
    });

    it('finishes on a second run after a Cloudflare call fails once routing is on', async () => {
      for (const failing of [
        { method: 'PATCH', path: '/email/routing' },
        { method: 'POST', path: '/email/routing/rules' },
      ]) {
        sqlite.prepare('DELETE FROM platform_settings').run();
        env = { ...env, DATABASE: createSqliteD1(sqlite) };
        let failed = false;
        const fake = cloudflare({
          ...NEW_ZONE,
          respond: (call) => {
            if (failed || call.method !== failing.method || call.path !== failing.path) {
              return undefined;
            }
            failed = true;
            return cloudflareError(500, 1001, 'Internal error');
          },
        });

        await expect(run(true), failing.path).rejects.toBeInstanceOf(CloudflareEmailApiError);
        expect(storedRecord(), failing.path).toBeNull();
        expect(await isAgentEmailOn(env), failing.path).toBe(false);

        // Routing is already on, so the second run asks for no consent and does not turn
        // routing on again.
        expect((await planAgentEmailSetup(env)).state, failing.path).toBe('ready');
        expect((await run()).state, failing.path).toBe('on');
        expect(
          fake.writes().filter((call) => call.path === '/email/routing/dns'),
          failing.path
        ).toHaveLength(1);
        expect(fake.state.rules, failing.path).toHaveLength(1);
      }
    });

    it('leaves a correct agent@ rule alone', async () => {
      const fake = cloudflare({
        ...STAGING_LIKE,
        rules: [{ id: 'rule-agent', ...DESIRED_RULE }],
      });
      expect((await run()).state).toBe('on');
      expect(fake.writes()).toEqual([]);
    });

    it('finds the agent@ rule on the last page a zone at the 200-rule limit can have', async () => {
      const fake = cloudflare({
        ...STAGING_LIKE,
        rules: [
          ...Array.from({ length: 199 }, (_, index) => ({
            matchers: [{ type: 'literal', field: 'to', value: `person${index}@${MAIN}` }],
          })),
          { id: 'rule-agent', ...DESIRED_RULE },
        ],
      });
      expect((await run()).state).toBe('on');
      expect(fake.writes()).toEqual([]);
    });

    it('finds the agent@ rule past the first page of rules', async () => {
      const unrelated = Array.from({ length: 50 }, (_, index) => ({
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: `person${index}@${MAIN}` }],
        actions: [{ type: 'forward', value: ['ops@example.com'] }],
      }));
      const fake = cloudflare({
        ...STAGING_LIKE,
        rules: [...unrelated, { id: 'rule-agent', ...DESIRED_RULE, enabled: false }],
      });
      expect((await run()).state).toBe('on');
      expect(fake.writes()).toEqual([
        { method: 'PUT', path: '/email/routing/rules/rule-agent', body: DESIRED_RULE },
      ]);
      expect(
        fake.calls.filter((call) => call.path === '/email/routing/rules' && call.method === 'GET')
      ).toHaveLength(2);
    });

    it('refuses to guess past the routing rule page limit', async () => {
      // Cloudflare allows 200 rules; a zone with more than the pages read cannot be judged.
      const fake = cloudflare({
        ...STAGING_LIKE,
        rules: Array.from({ length: 250 }, (_, index) => ({
          matchers: [{ type: 'literal', field: 'to', value: `person${index}@${MAIN}` }],
        })),
      });
      const refusal = await run().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((refusal as Error).message).toContain('more than 250 Email Routing rules');
      expect(fake.writes()).toEqual([]);
      expect(storedRecord()).toBeNull();
    });

    it('surfaces a failed Cloudflare call with its code and leaves agent email off', async () => {
      const fake = cloudflare({
        ...NEW_ZONE,
        respond: (call) =>
          call.method === 'POST' && call.path === '/email/routing/dns'
            ? cloudflareError(403, 10000, 'Authentication error')
            : undefined,
      });
      const failure = await run(true).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(CloudflareEmailApiError);
      expect(failure).toMatchObject({ status: 403, code: 10000 });
      expect((failure as Error).message).toBe(
        'Cloudflare POST /email/routing/dns failed with HTTP 403: 10000 Authentication error'
      );
      expect(fake.state.rules).toEqual([]);
      expect(storedRecord()).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);
    });
  });
});
