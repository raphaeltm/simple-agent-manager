/**
 * The agent email admin setup against a fake Cloudflare zone (DNS, Email Routing, Email Sending)
 * and a real SQLite database for the on-switch and attempt records. Each case starts from a zone
 * shape seen in practice: staging (routing already on for the subdomain), a zone that uses Email
 * Routing elsewhere, a zone new to Email Routing, and zones whose main domain has its own mail.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { CloudflareEmailApiError } from '../../../src/services/agent-email/cloudflare-email-api';
import { planAgentEmailSetup, runAgentEmailSetup } from '../../../src/services/agent-email/setup';
import { CLOUDFLARE_ROUTING_SPF } from '../../../src/services/agent-email/setup-changes';
import {
  AgentEmailMainDomainChangedError,
  AgentEmailSetupRefusedError,
} from '../../../src/services/agent-email/setup-errors';
import { AGENT_EMAIL_RULE_NAME } from '../../../src/services/agent-email/setup-routing-rule';
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
const ATTEMPT_KEY = `agent_email.setup_attempt:${DOMAIN}`;
const DESIRED_RULE = {
  name: AGENT_EMAIL_RULE_NAME,
  enabled: true,
  matchers: [{ type: 'literal', field: 'to', value: `agent@${DOMAIN}` }],
  actions: [{ type: 'worker', value: [WORKER] }],
};
const SUBADDRESSING = expect.objectContaining({ setting: 'subaddressing' });

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

  function stored(key: string): Record<string, unknown> | null {
    const row = sqlite
      .prepare('SELECT value, updated_by AS updatedBy FROM platform_settings WHERE key = ?')
      .get(key) as { value: string; updatedBy: string } | undefined;
    return row ? { ...JSON.parse(row.value), updatedBy: row.updatedBy } : null;
  }

  /** Runs the setup as the panel does: with the token of the plan it showed, when allowed. */
  async function run(consent = false) {
    const shown = await planAgentEmailSetup(env);
    return runAgentEmailSetup(env, {
      consentToken: consent ? shown.consentToken : null,
      userId: 'admin-1',
    });
  }

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

    it('is ready, with nothing to allow, where the zone already routes the subdomain', async () => {
      cloudflare(STAGING_LIKE);
      expect(await planAgentEmailSetup(env)).toEqual({
        state: 'ready',
        domain: DOMAIN,
        mainDomain: MAIN,
        mainDomainChanges: [],
        zoneChanges: [],
        consentToken: null,
        reason: null,
      });
    });

    it('asks to allow subaddressing for the zone when it is off', async () => {
      cloudflare({ ...STAGING_LIKE, routing: { enabled: true, support_subaddress: false } });
      const plan = await planAgentEmailSetup(env);
      expect(plan).toMatchObject({
        state: 'needs_consent',
        mainDomainChanges: [],
        zoneChanges: [{ setting: 'subaddressing', allowed: false }],
        consentToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(plan.zoneChanges[0]!.description).toContain(`name+anything@${MAIN}`);
    });

    it('asks to let Cloudflare add its SPF record and DKIM key in a zone new to Email Routing', async () => {
      const fake = cloudflare(NEW_ZONE);
      expect(await planAgentEmailSetup(env)).toEqual({
        state: 'needs_consent',
        domain: DOMAIN,
        mainDomain: MAIN,
        mainDomainChanges: [
          { type: 'TXT', name: MAIN, content: CLOUDFLARE_ROUTING_SPF, change: 'add' },
          { type: 'TXT', name: `cf2024-1._domainkey.${MAIN}`, content: null, change: 'add' },
        ],
        zoneChanges: [SUBADDRESSING],
        consentToken: expect.stringMatching(/^[0-9a-f]{64}$/),
        reason: expect.stringContaining(`${MAIN} has never used Email Routing`),
      });
      expect(fake.writes()).toEqual([]);
    });

    it('gives each set of listed changes its own consent token', async () => {
      cloudflare(NEW_ZONE);
      const first = (await planAgentEmailSetup(env)).consentToken;
      expect((await planAgentEmailSetup(env)).consentToken).toBe(first);
      cloudflare({ ...STAGING_LIKE, routing: { enabled: true, support_subaddress: false } });
      expect((await planAgentEmailSetup(env)).consentToken).not.toBe(first);
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
        expect(plan.consentToken, label).toBeNull();
        await expect(run(true), label).rejects.toBeInstanceOf(AgentEmailSetupRefusedError);
        expect(fake.writes(), label).toEqual([]);
      }
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
      expect(stored(ATTEMPT_KEY)).toBeNull();
    });

    it('does not count a TXT record that is not SPF as mail', async () => {
      cloudflare({
        ...NEW_ZONE,
        dns: [{ type: 'TXT', name: MAIN, content: '"google-site-verification=abc123"' }],
      });
      expect((await planAgentEmailSetup(env)).state).toBe('needs_consent');
    });

    it('refuses to judge a listing Cloudflare reports as partial', async () => {
      cloudflare({
        ...NEW_ZONE,
        dnsPageLimit: 1,
        dns: [
          { type: 'TXT', name: MAIN, content: '"google-site-verification=abc123"' },
          { type: 'TXT', name: MAIN, content: '"v=spf1 include:_spf.google.com ~all"' },
        ],
      });
      const failure = await planAgentEmailSetup(env).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CloudflareEmailApiError);
      expect((failure as Error).message).toBe(`Cloudflare listed 1 of 2 TXT records for ${MAIN}`);
    });

    it('judges only DNS lists by their counts, whatever other endpoints report', async () => {
      const fake = cloudflare({
        ...STAGING_LIKE,
        respond: (call) => {
          const odd =
            call.path === '/email/sending/subdomains'
              ? {
                  result: [{ tag: 'sending-1', name: DOMAIN, enabled: true }],
                  result_info: { page: 1 },
                }
              : call.path === '/email/routing/rules' && call.method === 'GET'
                ? { result: [], result_info: null }
                : null;
          return odd
            ? new Response(JSON.stringify({ success: true, errors: [], ...odd }), { status: 200 })
            : undefined;
        },
      });
      expect((await run()).state).toBe('on');
      expect(fake.writes().map((call) => call.path)).toEqual(['/email/routing/rules']);
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
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
    });
  });

  describe('run', () => {
    it('turns agent email on where the subdomain already routes, changing nothing on the main domain', async () => {
      const fake = cloudflare(STAGING_LIKE);
      const mainBefore = structuredClone(fake.state.dns.filter((record) => record.name === MAIN));
      expect(await isAgentEmailOn(env)).toBe(false);

      const result = await run();

      expect(result).toMatchObject({ state: 'on', domain: DOMAIN, mainDomain: MAIN });
      expect(fake.writes()).toEqual([
        { method: 'POST', path: '/email/routing/rules', body: DESIRED_RULE },
      ]);
      expect(fake.state.dns.filter((record) => record.name === MAIN)).toEqual(mainBefore);
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toEqual({
        domain: DOMAIN,
        enabledAt: expect.any(String),
        mainDomainChanges: [],
        zoneChanges: [],
        updatedBy: 'admin-1',
      });
      expect(stored(ATTEMPT_KEY)).toBeNull();
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

    it('changes nothing without consent, or with consent to a different plan', async () => {
      const fake = cloudflare(NEW_ZONE);
      const without = await run(false).catch((error: unknown) => error);
      expect(without).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((without as Error).message).toBe(
        `Allow the changes to ${MAIN} to turn agent email on.`
      );

      const stale = await runAgentEmailSetup(env, {
        consentToken: 'f'.repeat(64),
        userId: 'admin-1',
      }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((stale as Error).message).toContain('different from what you allowed');

      expect(fake.writes()).toEqual([]);
      expect(stored(ATTEMPT_KEY)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);
    });

    it('with consent, turns routing on by name and the main domain gains only the listed records', async () => {
      const fake = cloudflare(NEW_ZONE);
      const listed = (await planAgentEmailSetup(env)).mainDomainChanges;

      const result = await run(true);

      expect(result).toMatchObject({ state: 'on', mainDomainChanges: listed });
      expect(fake.writes()).toEqual([
        { method: 'POST', path: '/email/routing/dns', body: { name: DOMAIN } },
        { method: 'PATCH', path: '/email/routing', body: { support_subaddress: true } },
        { method: 'POST', path: '/email/routing/rules', body: DESIRED_RULE },
      ]);
      expect(fake.records('TXT', MAIN).map((record) => record.content)).toEqual([
        `"${CLOUDFLARE_ROUTING_SPF}"`,
      ]);
      expect(fake.records('MX', MAIN)).toEqual([]);
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toMatchObject({
        domain: DOMAIN,
        mainDomainChanges: listed,
        zoneChanges: ['subaddressing'],
      });
      expect(stored(ATTEMPT_KEY)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(true);
    });

    it('turns subaddressing on only after the admin allowed it', async () => {
      const fake = cloudflare({
        ...STAGING_LIKE,
        routing: { enabled: true, support_subaddress: false },
      });
      await expect(run(false)).rejects.toBeInstanceOf(AgentEmailSetupRefusedError);
      expect(fake.writes()).toEqual([]);

      expect((await run(true)).state).toBe('on');
      expect(fake.writes()).toEqual([
        { method: 'PATCH', path: '/email/routing', body: { support_subaddress: true } },
        { method: 'POST', path: '/email/routing/rules', body: DESIRED_RULE },
      ]);
    });

    it('accepts a main domain that gains fewer records than listed', async () => {
      const fake = cloudflare({ ...NEW_ZONE, firstUseAdds: () => [] });
      expect((await run(true)).state).toBe('on');
      expect(fake.records('TXT', MAIN)).toEqual([]);
    });

    it('stops with agent email off when the main domain gains a record it did not list, and keeps stopping', async () => {
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
      expect((failure as Error).message).toContain('added MX 10 route1.mx.cloudflare.net');
      expect((failure as Error).message).toContain('Agent email is still off');
      expect(error).toHaveBeenCalledWith('agent_email.setup_main_domain_changed', {
        mainDomain: MAIN,
        differences: 'added MX 10 route1.mx.cloudflare.net',
      });
      expect(fake.writes().map((call) => call.path)).toEqual(['/email/routing/dns']);
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);

      // The baseline outlives the failed run: routing being on now is no reason to skip the check.
      const changed = await planAgentEmailSetup(env);
      expect(changed).toMatchObject({
        state: 'changed',
        mainDomainChanges: [
          {
            type: 'MX',
            name: MAIN,
            content: 'route1.mx.cloudflare.net',
            priority: 10,
            change: 'add',
          },
        ],
        consentToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      await expect(run(false)).rejects.toBeInstanceOf(AgentEmailSetupRefusedError);
      expect(await isAgentEmailOn(env)).toBe(false);

      // Allowing the records as they are turns it on, without turning routing on again.
      expect((await run(true)).state).toBe('on');
      expect(fake.writes().filter((call) => call.path === '/email/routing/dns')).toHaveLength(1);
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toMatchObject({
        mainDomainChanges: [expect.objectContaining({ content: 'route1.mx.cloudflare.net' })],
      });
    });

    it('binds consent to the priority of an unlisted MX record as well', async () => {
      const fake = cloudflare({
        ...NEW_ZONE,
        firstUseAdds: (zone) => [
          ...cloudflareRoutingFirstUse(zone),
          { type: 'MX', name: zone, content: 'route1.mx.cloudflare.net', priority: 10 },
        ],
      });
      await expect(run(true)).rejects.toBeInstanceOf(AgentEmailMainDomainChangedError);
      const shown = await planAgentEmailSetup(env);
      expect(shown.mainDomainChanges).toEqual([
        {
          type: 'MX',
          name: MAIN,
          content: 'route1.mx.cloudflare.net',
          priority: 10,
          change: 'add',
        },
      ]);
      expect(shown.reason).toContain('added MX 10 route1.mx.cloudflare.net');

      // The record moves to another priority after the admin read the plan.
      const mx = fake.state.dns.find((record) => record.type === 'MX' && record.name === MAIN)!;
      mx.priority = 90;
      const stale = await runAgentEmailSetup(env, {
        consentToken: shown.consentToken,
        userId: 'admin-1',
      }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((stale as Error).message).toContain('different from what you allowed');
      expect(await isAgentEmailOn(env)).toBe(false);
    });

    it('lets a fixed main domain pass the check again without new consent', async () => {
      const fake = cloudflare({
        ...NEW_ZONE,
        firstUseAdds: (zone) => [
          ...cloudflareRoutingFirstUse(zone),
          { type: 'TXT', name: zone, content: '"v=spf1 include:example.net -all"' },
        ],
      });
      await expect(run(true)).rejects.toBeInstanceOf(AgentEmailMainDomainChangedError);

      // The admin deletes the unexpected record in Cloudflare.
      fake.state.dns = fake.state.dns.filter((record) => !record.content.includes('example.net'));
      expect(await planAgentEmailSetup(env)).toMatchObject({ state: 'ready', consentToken: null });
      expect((await run()).state).toBe('on');
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
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
      expect((await planAgentEmailSetup(env)).state).toBe('changed');
    });

    it('a run that starts while another has turned routing on checks against the first baseline', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fake = cloudflare({
        ...NEW_ZONE,
        firstUseAdds: (zone) => [
          ...cloudflareRoutingFirstUse(zone),
          { type: 'MX', name: zone, content: 'route1.mx.cloudflare.net', priority: 10 },
        ],
        // The first run's enable has reached Cloudflare; hold its answer.
        hold: (call) => (call.path === '/email/routing/dns' ? held : undefined),
      });
      const shown = await planAgentEmailSetup(env);
      const first = runAgentEmailSetup(env, {
        consentToken: shown.consentToken,
        userId: 'admin-1',
      }).catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(fake.calls.some((call) => call.path === '/email/routing/dns')).toBe(true)
      );

      // A second run, allowed from the same plan, sees routing on and the subdomain's MX records.
      expect(fake.records('MX', DOMAIN)).toHaveLength(3);
      const second = await runAgentEmailSetup(env, {
        consentToken: shown.consentToken,
        userId: 'admin-2',
      }).catch((error: unknown) => error);
      release();

      // It checks the first run's baseline, finds the unlisted MX record, and so lists it to be
      // allowed: the consent it carries was for the original changes only.
      expect(second).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((second as Error).message).toContain('different from what you allowed');
      expect(await first).toBeInstanceOf(AgentEmailMainDomainChangedError);
      expect((await planAgentEmailSetup(env)).state).toBe('changed');
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);
      expect(stored(ATTEMPT_KEY)).toMatchObject({ startedBy: 'admin-1', baseline: [] });
    });

    it('lets one run change Cloudflare at a time', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fake = cloudflare({
        ...NEW_ZONE,
        hold: (call) => (call.path === '/email/routing/dns' ? held : undefined),
      });
      const shown = await planAgentEmailSetup(env);
      const first = runAgentEmailSetup(env, {
        consentToken: shown.consentToken,
        userId: 'admin-1',
      });
      await vi.waitFor(() =>
        expect(fake.calls.some((call) => call.path === '/email/routing/dns')).toBe(true)
      );
      // The second run's plan reflects the first run's attempt: nothing new to allow.
      const midway = await planAgentEmailSetup(env);
      expect(midway).toMatchObject({ state: 'ready', consentToken: null });
      const writesBefore = fake.writes().length;
      const second = await runAgentEmailSetup(env, { consentToken: null, userId: 'admin-2' }).catch(
        (error: unknown) => error
      );
      expect(second).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((second as Error).message).toContain('Another agent email setup run is in progress');
      expect(fake.writes()).toHaveLength(writesBefore);
      release();

      expect((await first).state).toBe('on');
      expect(await isAgentEmailOn(env)).toBe(true);
      expect(stored(ATTEMPT_KEY)).toBeNull();
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toMatchObject({ updatedBy: 'admin-1' });
    });

    it('stops a run whose lease another run took over from turning agent email on', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holdNext = true;
      const fake = cloudflare({
        ...NEW_ZONE,
        hold: (call) => {
          if (!holdNext || call.path !== '/email/routing/dns') return undefined;
          holdNext = false;
          return held;
        },
      });
      const shown = await planAgentEmailSetup(env);
      const first = runAgentEmailSetup(env, {
        consentToken: shown.consentToken,
        userId: 'admin-1',
      }).catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(fake.calls.some((call) => call.path === '/email/routing/dns')).toBe(true)
      );
      // The first run's lease lapses, as if its Worker had died.
      const attemptRow = stored(ATTEMPT_KEY)!;
      delete attemptRow.updatedBy;
      sqlite
        .prepare('UPDATE platform_settings SET value = ? WHERE key = ?')
        .run(
          JSON.stringify({ ...attemptRow, leaseUntil: '2000-01-01T00:00:00.000Z' }),
          ATTEMPT_KEY
        );

      expect((await runAgentEmailSetup(env, { consentToken: null, userId: 'admin-2' })).state).toBe(
        'on'
      );
      release();

      const failure = await first;
      expect(failure).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((failure as Error).message).toContain('took over before this one finished');
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toMatchObject({ updatedBy: 'admin-2' });
    });

    it('refuses a run that loses the start to a concurrent one', async () => {
      let armed = false;
      const competitor = {
        domain: DOMAIN,
        startedAt: '2026-10-23T08:00:00.000Z',
        startedBy: 'admin-2',
        baseline: [],
        allowed: [{ type: 'TXT', content: CLOUDFLARE_ROUTING_SPF }],
        zoneChanges: ['subaddressing'],
        owner: 'run-2',
        leaseUntil: '2999-01-01T00:00:00.000Z',
      };
      const fake = cloudflare({
        ...NEW_ZONE,
        // Another run stores its attempt after this run read that there was none.
        hold: async (call) => {
          if (!armed || call.path !== '/email/sending/subdomains') return;
          armed = false;
          await new Promise((resolve) => setTimeout(resolve, 0));
          sqlite
            .prepare(
              `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'admin-2')`
            )
            .run(ATTEMPT_KEY, JSON.stringify(competitor), competitor.startedAt);
        },
      });
      const shown = await planAgentEmailSetup(env);
      armed = true;

      const failure = await runAgentEmailSetup(env, {
        consentToken: shown.consentToken,
        userId: 'admin-1',
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AgentEmailSetupRefusedError);
      expect((failure as Error).message).toBe(
        'Another agent email setup run started at the same time. Check again.'
      );
      expect(fake.writes()).toEqual([]);
      expect(stored(ATTEMPT_KEY)).toMatchObject({ startedBy: 'admin-2' });
    });

    it('reports pending until the subdomain MX records show, then finishes without new consent', async () => {
      const fake = cloudflare({ ...NEW_ZONE, mxVisibleAfterEnable: false });

      const first = await run(true);
      expect(first.state).toBe('pending');
      expect(first.reason).toContain('Run the setup again in a minute');
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
      expect(stored(ATTEMPT_KEY)).toMatchObject({ zoneChanges: ['subaddressing'] });

      // Still not visible: the consent given holds, and the SPF record is not a surprise. The
      // subaddressing change is still to be made, so it is still shown, as allowed.
      expect(await planAgentEmailSetup(env)).toMatchObject({
        state: 'ready',
        consentToken: null,
        zoneChanges: [{ setting: 'subaddressing', allowed: true }],
      });
      expect(stored(ATTEMPT_KEY)).toMatchObject({ owner: null, leaseUntil: null });
      expect((await run()).state).toBe('pending');

      fake.state.dns.push(
        ...cloudflareRoutingMx(DOMAIN).map((record, index) => ({ id: `mx-${index}`, ...record }))
      );
      expect((await run()).state).toBe('on');
      expect(fake.writes().filter((call) => call.path === '/email/routing/dns')).toHaveLength(2);
      expect(fake.writes().filter((call) => call.method === 'PATCH')).toHaveLength(1);
      expect(fake.records('TXT', MAIN)).toHaveLength(1);
      expect(stored(ATTEMPT_KEY)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(true);
    });

    it('finishes on a second run after a Cloudflare call fails once routing is on', async () => {
      for (const failing of [
        { method: 'PATCH', path: '/email/routing' },
        { method: 'POST', path: '/email/routing/rules' },
      ]) {
        sqlite.prepare('DELETE FROM platform_settings').run();
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
        expect(stored(AGENT_EMAIL_SETUP_KEY), failing.path).toBeNull();
        expect(await isAgentEmailOn(env), failing.path).toBe(false);

        // Routing is on and the consent given holds, so the second run does not ask again
        // and does not turn routing on again.
        expect((await planAgentEmailSetup(env)).state, failing.path).toBe('ready');
        expect((await run()).state, failing.path).toBe('on');
        expect(
          fake.writes().filter((call) => call.path === '/email/routing/dns'),
          failing.path
        ).toHaveLength(1);
        expect(fake.state.rules, failing.path).toHaveLength(1);
      }
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

        expect((await run()).state).toBe('on');
        expect(fake.writes()).toEqual([
          { method: 'PUT', path: '/email/routing/rules/rule-agent', body: DESIRED_RULE },
        ]);
        expect(fake.state.rules).toHaveLength(1);
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
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
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
      expect(stored(AGENT_EMAIL_SETUP_KEY)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(false);
    });
  });
});
