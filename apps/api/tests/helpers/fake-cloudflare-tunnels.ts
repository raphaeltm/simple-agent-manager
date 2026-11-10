/**
 * Stateful fake of the Cloudflare tunnel + DNS endpoints used by
 * `services/cloudflare-tunnel-api.ts`. It enforces the constraints the real API enforces and
 * that the lifecycle depends on: one CNAME per name (81053 against a different record, 81058
 * against an identical one), tunnel delete refused while connectors are attached, 404 for
 * unknown ids. Faults can be injected per operation, including a "lost response" that
 * commits the mutation but never answers, which is what makes create recovery necessary.
 */
export interface FakeTunnel {
  id: string;
  name: string;
  deleted: boolean;
  connections: number;
  ingress: unknown[] | null;
  token: string;
}

export interface FakeDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  comment?: string;
}

export type FakeFault =
  | { kind: 'status'; status: number; code?: number }
  | { kind: 'network' }
  | { kind: 'lost-after-commit' }
  | { kind: 'hook'; run: () => void | Promise<void> }
  /** Answer normally; used to target a later call of the same operation. */
  | { kind: 'pass' };

export interface FakeCall {
  method: string;
  op: string;
  path: string;
}

const BASE = 'https://api.cloudflare.com/client/v4';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok(result: unknown): Response {
  return json(200, { success: true, errors: [], messages: [], result });
}

function fail(status: number, code: number, message: string): Response {
  return json(status, { success: false, errors: [{ code, message }], messages: [], result: null });
}

export class FakeCloudflare {
  readonly tunnels = new Map<string, FakeTunnel>();
  readonly dns = new Map<string, FakeDnsRecord>();
  readonly calls: FakeCall[] = [];
  private readonly faults = new Map<string, FakeFault[]>();
  private counter = 0;

  constructor(
    readonly accountId: string,
    readonly zoneId: string
  ) {}

  /** Queue a fault for the next call to `op` (e.g. 'tunnel.create', 'dns.create'). */
  inject(op: string, fault: FakeFault, times = 1): void {
    const queue = this.faults.get(op) ?? [];
    for (let i = 0; i < times; i++) queue.push(fault);
    this.faults.set(op, queue);
  }

  liveTunnels(): FakeTunnel[] {
    return [...this.tunnels.values()].filter((tunnel) => !tunnel.deleted);
  }

  records(): FakeDnsRecord[] {
    return [...this.dns.values()];
  }

  callCount(op: string): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  seedTunnel(name: string): FakeTunnel {
    const id = `00000000-0000-4000-9000-${String(++this.counter).padStart(12, '0')}`;
    const tunnel: FakeTunnel = {
      id,
      name,
      deleted: false,
      connections: 0,
      ingress: null,
      token: `connector-token-${id}-SECRET`,
    };
    this.tunnels.set(id, tunnel);
    return tunnel;
  }

  seedDnsRecord(record: Omit<FakeDnsRecord, 'id'>): FakeDnsRecord {
    const full = { id: `dns-${++this.counter}`, ...record };
    this.dns.set(full.id, full);
    return full;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (!url.href.startsWith(BASE)) throw new Error(`Unexpected fetch ${url.href}`);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/client/v4', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const op = this.classify(method, path);
    this.calls.push({ method, op, path });

    const fault = this.faults.get(op)?.shift();
    if (fault?.kind === 'hook') await fault.run();
    if (fault?.kind === 'network') throw new TypeError('fetch failed');
    if (fault?.kind === 'status') {
      return fail(fault.status, fault.code ?? 10000, `injected ${op} failure`);
    }
    const response = this.handle(op, method, path, url, body);
    if (fault?.kind === 'lost-after-commit') throw new TypeError('connection reset');
    return response;
  };

  private classify(method: string, path: string): string {
    const tunnelBase = `/accounts/${this.accountId}/cfd_tunnel`;
    const dnsBase = `/zones/${this.zoneId}/dns_records`;
    if (path === tunnelBase) return method === 'POST' ? 'tunnel.create' : 'tunnel.list';
    if (path.startsWith(`${tunnelBase}/`)) {
      if (path.endsWith('/token')) return 'tunnel.token';
      if (path.endsWith('/configurations')) return 'tunnel.configure';
      if (path.endsWith('/connections')) return 'tunnel.connections_delete';
      return 'tunnel.delete';
    }
    if (path === dnsBase) return method === 'POST' ? 'dns.create' : 'dns.list';
    if (path.startsWith(`${dnsBase}/`)) return method === 'DELETE' ? 'dns.delete' : 'dns.get';
    return `unknown ${method} ${path}`;
  }

  private handle(
    op: string,
    _method: string,
    path: string,
    url: URL,
    body: Record<string, unknown>
  ): Response {
    const lastSegment = (offset = 0) => path.split('/').at(-1 - offset) ?? '';
    switch (op) {
      case 'tunnel.list': {
        const name = url.searchParams.get('name');
        const deletedFilter = url.searchParams.get('is_deleted');
        return ok(
          [...this.tunnels.values()]
            .filter((tunnel) => (name ? tunnel.name.includes(name) : true))
            .filter((tunnel) => deletedFilter !== 'false' || !tunnel.deleted)
            .map((tunnel) => ({
              id: tunnel.id,
              name: tunnel.name,
              deleted_at: tunnel.deleted ? '2026-11-10T00:00:00Z' : null,
            }))
        );
      }
      case 'tunnel.create': {
        const id = `00000000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`;
        const tunnel: FakeTunnel = {
          id,
          name: String(body.name),
          deleted: false,
          connections: 0,
          ingress: null,
          token: `connector-token-${id}-SECRET`,
        };
        this.tunnels.set(id, tunnel);
        return ok({ id, name: tunnel.name, config_src: body.config_src, token: tunnel.token });
      }
      case 'tunnel.token': {
        const tunnel = this.tunnels.get(lastSegment(1));
        if (!tunnel || tunnel.deleted) return fail(404, 1003, 'tunnel not found');
        return ok(tunnel.token);
      }
      case 'tunnel.configure': {
        const tunnel = this.tunnels.get(lastSegment(1));
        if (!tunnel || tunnel.deleted) return fail(404, 1003, 'tunnel not found');
        tunnel.ingress = ((body.config as { ingress?: unknown[] } | undefined)?.ingress ?? null) as
          unknown[] | null;
        return ok({ version: 1 });
      }
      case 'tunnel.connections_delete': {
        const tunnel = this.tunnels.get(lastSegment(1));
        if (!tunnel || tunnel.deleted) return fail(404, 1003, 'tunnel not found');
        tunnel.connections = 0;
        return ok(null);
      }
      case 'tunnel.delete': {
        const tunnel = this.tunnels.get(lastSegment());
        if (!tunnel || tunnel.deleted) return fail(404, 1003, 'tunnel not found');
        if (tunnel.connections > 0) return fail(400, 1022, 'tunnel has active connections');
        tunnel.deleted = true;
        return ok({ id: tunnel.id });
      }
      case 'dns.list': {
        const name = url.searchParams.get('name');
        return ok(this.records().filter((record) => !name || record.name === name));
      }
      case 'dns.get': {
        const record = this.dns.get(lastSegment());
        return record ? ok(record) : fail(404, 81044, 'record not found');
      }
      case 'dns.create': {
        const name = String(body.name);
        const existing = this.records().find((record) => record.name === name);
        if (existing) {
          const identical = existing.type === body.type && existing.content === body.content;
          return identical
            ? fail(400, 81058, 'An identical record already exists.')
            : fail(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
        }
        return ok(
          this.seedDnsRecord({
            name,
            type: String(body.type),
            content: String(body.content),
            proxied: body.proxied === true,
            comment: typeof body.comment === 'string' ? body.comment : undefined,
          })
        );
      }
      case 'dns.delete': {
        const id = lastSegment();
        if (!this.dns.delete(id)) return fail(404, 81044, 'record not found');
        return ok({ id });
      }
      default:
        return fail(400, 7000, `unhandled ${op}`);
    }
  }
}
