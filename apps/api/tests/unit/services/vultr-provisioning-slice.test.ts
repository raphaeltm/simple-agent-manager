/**
 * Rule-35 vertical slice for Vultr provisioning (H3).
 *
 * APPROACH — PREFERRED path (per the task): this drives the REAL control-plane
 * credential → provider → Vultr-HTTP path through the actual
 * `createProviderForUser()`. Only the true system boundaries are mocked:
 *
 *   - the drizzle `db` (table-identity routing: empty for every composable-
 *     credentials / platform query, a single vultr `cloud-provider` row for the
 *     legacy lookup),
 *   - `decrypt` (returns the raw token verbatim),
 *   - `global.fetch` (an inline Vultr API v2 mock — equivalent to the providers
 *     package `createVultrFetchMock` fixture, inlined to avoid a cross-package
 *     test-fixture import).
 *
 * Everything in between is real: the CC resolver + lazy-backfill run against the
 * empty CC tables, return no data, and `createProviderForUser` falls through to
 * the legacy single-table lookup, decrypts the vultr token, calls the real
 * providers-package `createProvider()`/`VultrProvider`, and issues real Vultr
 * HTTP calls (intercepted at `fetch`). We then assert the outbound
 * `POST /v2/instances` payload AND that an empty `main_ip` (0.0.0.0) is tolerated
 * as `ip: ''`.
 */
import { VultrProvider } from '@simple-agent-manager/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { decrypt } from '../../../src/services/encryption';
import { createProviderForUser } from '../../../src/services/provider-credentials';

// vitest hoists vi.mock above the imports, so the `decrypt` import above resolves
// to this stub (the same pattern as provider-credentials-edge-cases.test.ts).
vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(),
}));

const mockDecrypt = decrypt as ReturnType<typeof vi.fn>;

const RAW_VULTR_TOKEN = 'vultr-raw-token-abc123';
const USER_ID = 'user-vultr-1';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

/**
 * A drizzle-shaped mock whose result set depends only on WHICH table `.from()`
 * targets. Every composable-credentials + platform query resolves empty; only the
 * legacy `credentials` table's `.limit()`-terminated lookup yields the vultr row.
 * This forces CC resolution to miss and `createProviderForUser` to fall through to
 * the legacy path — without persisting the runBackfill no-op inserts.
 */
function makeVultrCredentialDbMock(vultrRow: Record<string, unknown>) {
  function rowsFor(table: unknown, limited: boolean): unknown[] {
    // Legacy `credentials` lookup is `.limit(1)`-terminated; the runBackfill scan
    // reads the same table WITHOUT a limit and must stay empty so no inserts run.
    if (table === schema.credentials) return limited ? [vultrRow] : [];
    return []; // cc_credentials / cc_configurations / cc_attachments / platform_credentials
  }

  const makeBuilder = () => {
    let table: unknown;
    const builder = {
      from: (t: unknown) => {
        table = t;
        return builder;
      },
      where: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      limit: () => Promise.resolve(rowsFor(table, true)),
      // Thenable: `await db.select().from(x).where(y)` (no `.limit`) resolves here.
      then: (
        resolve: (value: unknown[]) => unknown,
        reject: (reason?: unknown) => unknown,
      ) => Promise.resolve(rowsFor(table, false)).then(resolve, reject),
    };
    return builder;
  };

  return {
    select: () => makeBuilder(),
    // runBackfill guards every insert on length > 0; with empty inputs it never
    // fires, but provide a no-op so an accidental insert can't throw.
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) }),
  } as unknown as Parameters<typeof createProviderForUser>[0];
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Inline Vultr API v2 fetch mock (equivalent to createVultrFetchMock): resolves
 * an Ubuntu os_id, accepts the create, and returns main_ip 0.0.0.0 everywhere so
 * the IP poll times out and the empty-IP tolerance is exercised.
 */
function makeVultrFetchMock(calls: RecordedCall[]) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({
      url: u,
      method,
      body: init?.body as string | undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });

    if (method === 'GET' && u.includes('/v2/os')) {
      return Promise.resolve(new Response(
        JSON.stringify({
          os: [{ id: 1743, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' }],
          meta: { total: 1, links: { next: '', prev: '' } },
        }),
        { status: 200 },
      ));
    }
    const pendingInstance = {
      id: 'i-slice-1',
      main_ip: '0.0.0.0',
      status: 'pending',
      power_status: 'stopped',
      server_status: 'none',
      region: 'fra',
      plan: 'vc2-2c-4gb',
      date_created: '2026-01-01T00:00:00Z',
      label: 'slice node',
      tags: [],
    };
    if (method === 'POST' && /\/v2\/instances$/.test(u)) {
      return Promise.resolve(new Response(JSON.stringify({ instance: pendingInstance }), { status: 202 }));
    }
    if (method === 'GET' && /\/v2\/instances\/[^/?]+$/.test(u)) {
      // Poll always sees 0.0.0.0 → provider returns empty IP after the poll budget.
      return Promise.resolve(new Response(JSON.stringify({ instance: pendingInstance }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: 'not found', status: 404 }), { status: 404 }));
  });
}

describe('Vultr provisioning vertical slice — createProviderForUser → VultrProvider → Vultr HTTP', () => {
  const env = {
    // Small poll budget so createVM resolves quickly and returns an empty IP.
    VULTR_IP_POLL_TIMEOUT_MS: '20',
    VULTR_IP_POLL_INTERVAL_MS: '5',
    VULTR_API_TIMEOUT_MS: '1000',
  } as unknown as Parameters<typeof createProviderForUser>[3];

  beforeEach(() => {
    mockDecrypt.mockResolvedValue(RAW_VULTR_TOKEN);
  });

  it('resolves a real VultrProvider from a legacy vultr credential and provisions a VM', async () => {
    const db = makeVultrCredentialDbMock({
      id: 'cred-vultr-1',
      userId: USER_ID,
      projectId: null,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'vultr',
      encryptedToken: 'cipher',
      iv: 'iv',
      isActive: true,
    });

    const calls: RecordedCall[] = [];
    globalThis.fetch = makeVultrFetchMock(calls);

    // --- Real control-plane credential → provider resolution -------------------
    const resolved = await createProviderForUser(db, USER_ID, 'enc-key', env, 'vultr');

    expect(resolved).not.toBeNull();
    expect(resolved!.provider).toBeInstanceOf(VultrProvider);
    expect(resolved!.providerName).toBe('vultr');
    expect(resolved!.credentialSource).toBe('user');
    // The decrypted raw token flowed into the provider — prove decrypt was consulted.
    expect(mockDecrypt).toHaveBeenCalled();

    // --- Real provider.createVM → real Vultr HTTP (intercepted at fetch) --------
    const vm = await resolved!.provider.createVM({
      name: 'slice node',
      size: 'small',
      location: 'fra',
      userData: '#cloud-config\nhostname: slice\n',
      labels: { 'managed-by': 'sam', 'node-id': 'slice-1' },
    });

    // Empty main_ip (0.0.0.0) is tolerated → ip === '' (heartbeat backfill fallback).
    expect(vm.ip).toBe('');
    expect(vm.id).toBe('i-slice-1');
    expect(vm.status).toBe('initializing');

    // --- Outbound POST /v2/instances payload is correct ------------------------
    const createCall = calls.find((c) => c.method === 'POST' && /\/v2\/instances$/.test(c.url));
    expect(createCall).toBeDefined();
    expect(createCall!.url).toBe('https://api.vultr.com/v2/instances');
    const body = JSON.parse(createCall!.body as string);
    expect(body.region).toBe('fra');
    expect(body.plan).toBe('vc2-2c-4gb'); // small
    expect(body.os_id).toBe(1743); // Ubuntu, resolved via GET /v2/os
    expect(body.label).toBe('slice node');
    expect(body.hostname).toBe('slice-node');
    expect(body.backups).toBe('disabled');
    expect(body.activation_email).toBe(false);
    expect(body.tags).toEqual(['managed-by=sam', 'node-id=slice-1']);
    // The raw decrypted token is used as the Bearer credential on the wire.
    expect(createCall!.headers?.Authorization).toBe(`Bearer ${RAW_VULTR_TOKEN}`);
  });
});
