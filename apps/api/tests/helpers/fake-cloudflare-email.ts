/**
 * A fake Cloudflare zone for the agent email admin setup (`src/services/agent-email/setup.ts`):
 * DNS records, Email Routing settings and rules, and Email Sending subdomains, served through a
 * `fetch` stub at the real API paths. Every response is a fresh `Response`.
 *
 * Turning routing on for a subdomain models what staging showed (2026-10-23): the zone then reads
 * `enabled: true`, the subdomain gets Cloudflare's three MX records, and the first time the zone
 * ever uses Email Routing the root domain gains Cloudflare's SPF record and a locked DKIM key.
 */
import { vi } from 'vitest';

export const FAKE_CF_ZONE_ID = 'zone-fixture';
const ZONE_PREFIX = `https://api.cloudflare.com/client/v4/zones/${FAKE_CF_ZONE_ID}`;

export interface FakeDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export interface FakeRoutingRule {
  id: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

export type FakeRecordInput = Omit<FakeDnsRecord, 'id'>;

export interface FakeCloudflareEmailOptions {
  zoneName?: string;
  dns?: FakeRecordInput[];
  routing?: { enabled?: boolean; support_subaddress?: boolean };
  /** Whether the zone used Email Routing before; defaults to `routing.enabled`. */
  usedRoutingBefore?: boolean;
  sending?: Array<{ name: string; enabled?: boolean }>;
  rules?: Array<Omit<FakeRoutingRule, 'id'> & { id?: string }>;
  /** Root-domain records added the first time the zone uses Email Routing. */
  firstUseAdds?: (zoneName: string) => FakeRecordInput[];
  /** False: enabling a subdomain does not make its MX records visible yet. */
  mxVisibleAfterEnable?: boolean;
  /** Runs after a subdomain enable changed the zone, to model further changes. */
  onEnable?: (dns: FakeDnsRecord[]) => void;
  /** Return a response to replace the fake's own for one call. */
  respond?: (call: FakeCall) => Response | undefined;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

export function cloudflareRoutingFirstUse(zoneName: string): FakeRecordInput[] {
  return [
    { type: 'TXT', name: zoneName, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
    { type: 'TXT', name: `cf2024-1._domainkey.${zoneName}`, content: '"v=DKIM1; k=rsa; p=MIIB"' },
  ];
}

export function cloudflareRoutingMx(name: string): FakeRecordInput[] {
  return [
    { type: 'MX', name, content: 'route1.mx.cloudflare.net', priority: 25 },
    { type: 'MX', name, content: 'route2.mx.cloudflare.net', priority: 43 },
    { type: 'MX', name, content: 'route3.mx.cloudflare.net', priority: 63 },
  ];
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function cloudflareError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code, message }], result: null }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export function fakeCloudflareEmail(options: FakeCloudflareEmailOptions = {}) {
  const zoneName = options.zoneName ?? 'fixture.example';
  let nextId = 1;
  const id = (prefix: string) => `${prefix}-${nextId++}`;
  const state = {
    dns: (options.dns ?? []).map((record) => ({ id: id('dns'), ...record })),
    routing: {
      enabled: options.routing?.enabled ?? false,
      support_subaddress: options.routing?.support_subaddress ?? false,
    },
    usedRoutingBefore: options.usedRoutingBefore ?? options.routing?.enabled ?? false,
    sending: (options.sending ?? []).map((subdomain) => ({ tag: id('sending'), ...subdomain })),
    rules: (options.rules ?? []).map((rule) => ({ ...rule, id: rule.id ?? id('rule') })),
    mxVisibleAfterEnable: options.mxVisibleAfterEnable ?? true,
  };
  const calls: FakeCall[] = [];

  const addRecords = (records: FakeRecordInput[]) => {
    for (const record of records) state.dns.push({ id: id('dns'), ...record });
  };

  function handle(call: FakeCall, url: URL): Response {
    const { method, path, body } = call;
    if (method === 'GET' && path === '') return ok({ id: FAKE_CF_ZONE_ID, name: zoneName });
    if (method === 'GET' && path === '/dns_records') {
      const type = url.searchParams.get('type');
      const name = url.searchParams.get('name')?.toLowerCase();
      return ok(
        state.dns.filter((record) => record.type === type && record.name.toLowerCase() === name)
      );
    }
    if (method === 'GET' && path === '/email/routing') {
      return ok({ name: zoneName, ...state.routing });
    }
    if (method === 'PATCH' && path === '/email/routing') {
      Object.assign(state.routing, body as object);
      return ok({ name: zoneName, ...state.routing });
    }
    if (method === 'POST' && path === '/email/routing/dns') {
      const name = (body as { name?: string } | null)?.name;
      if (!name || name === zoneName) return cloudflareError(400, 2007, 'Invalid subdomain');
      if (!state.usedRoutingBefore) {
        addRecords((options.firstUseAdds ?? cloudflareRoutingFirstUse)(zoneName));
        state.usedRoutingBefore = true;
      }
      state.routing.enabled = true;
      const hasMx = state.dns.some((record) => record.type === 'MX' && record.name === name);
      if (state.mxVisibleAfterEnable && !hasMx) addRecords(cloudflareRoutingMx(name));
      options.onEnable?.(state.dns);
      return ok({ name, enabled: true });
    }
    if (method === 'GET' && path === '/email/routing/rules') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '20');
      return ok(state.rules.slice((page - 1) * perPage, page * perPage));
    }
    if (method === 'POST' && path === '/email/routing/rules') {
      const rule = { id: id('rule'), ...(body as Omit<FakeRoutingRule, 'id'>) };
      state.rules.push(rule);
      return ok(rule);
    }
    const ruleMatch = /^\/email\/routing\/rules\/([^/]+)$/.exec(path);
    if (method === 'PUT' && ruleMatch) {
      const index = state.rules.findIndex((rule) => rule.id === decodeURIComponent(ruleMatch[1]!));
      if (index < 0) return cloudflareError(404, 1000, 'Rule not found');
      state.rules[index] = { id: state.rules[index]!.id, ...(body as Omit<FakeRoutingRule, 'id'>) };
      return ok(state.rules[index]);
    }
    if (method === 'GET' && path === '/email/sending/subdomains') return ok(state.sending);
    return cloudflareError(404, 7003, `No route for ${method} ${path}`);
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(ZONE_PREFIX)) throw new Error(`Unexpected fetch ${url.href}`);
    const call: FakeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname.slice(new URL(ZONE_PREFIX).pathname.length),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return options.respond?.(call) ?? handle(call, url);
  });

  return {
    state,
    calls,
    fetchMock,
    /** Every call that changes Cloudflare state. */
    writes: () => calls.filter((call) => call.method !== 'GET'),
    records: (type: string, name: string) =>
      state.dns.filter((record) => record.type === type && record.name === name),
  };
}
