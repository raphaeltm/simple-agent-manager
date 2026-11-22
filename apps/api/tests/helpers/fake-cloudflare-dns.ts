/**
 * A fake Cloudflare DNS zone that enforces the parts of the API contract SAM relies on
 * (`.claude/rules/23`): bearer auth, the zone path, only documented list filters
 * (https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/),
 * case-insensitive name/content filters, offset pagination, name ordering, record-id PUT and
 * DELETE with Cloudflare's 404 for a missing id, and 81058 on a duplicate create.
 *
 * Install with `vi.stubGlobal('fetch', zone.fetch)`. Any request outside the DNS API fails the
 * test loudly instead of passing silently.
 */
export interface FakeDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

const LIST_PARAMS = new Set([
  'type',
  'name',
  'name.exact',
  'name.endswith',
  'name.startswith',
  'name.contains',
  'content',
  'content.exact',
  'page',
  'per_page',
  'order',
  'direction',
  'match',
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cfError(code: number, message: string, status: number): Response {
  return json({ success: false, errors: [{ code, message }], result: null }, status);
}

export function createFakeCloudflareDns(options: {
  zoneId: string;
  token: string;
  seed?: FakeDnsRecord[];
  /** Called before each request is answered; may mutate the zone to model a race. */
  beforeRequest?: (method: string, url: URL) => void;
}) {
  const records = new Map<string, FakeDnsRecord>();
  for (const record of options.seed ?? []) records.set(record.id, { ...record });
  let nextId = 1;
  const requests: Array<{ method: string; url: string }> = [];
  const base = `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/dns_records`;

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ method, url: url.href });
    if (!url.href.startsWith(base)) {
      throw new Error(`Unexpected request outside the fake DNS zone: ${method} ${url.href}`);
    }
    const headers = new Headers(init?.headers);
    if (headers.get('Authorization') !== `Bearer ${options.token}`) {
      return cfError(10000, 'Authentication error', 403);
    }
    options.beforeRequest?.(method, url);
    const rest = url.pathname.slice(new URL(base).pathname.length);

    if (method === 'GET' && rest === '') {
      for (const key of url.searchParams.keys()) {
        if (!LIST_PARAMS.has(key)) return cfError(1004, `Unknown filter ${key}`, 400);
      }
      const p = url.searchParams;
      const lower = (value: string | null) => value?.toLowerCase() ?? null;
      const exactName = lower(p.get('name') ?? p.get('name.exact'));
      const endsWith = lower(p.get('name.endswith'));
      const exactContent = lower(p.get('content') ?? p.get('content.exact'));
      const type = p.get('type');
      const perPage = Number(p.get('per_page') ?? '100');
      const page = Number(p.get('page') ?? '1');
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 5_000_000) {
        return cfError(1004, 'per_page out of range', 400);
      }
      if (!Number.isInteger(page) || page < 1) return cfError(1004, 'page out of range', 400);
      let matched = [...records.values()].filter(
        (r) =>
          (!type || r.type === type) &&
          (!exactName || r.name.toLowerCase() === exactName) &&
          (!endsWith || r.name.toLowerCase().endsWith(endsWith)) &&
          (!exactContent || r.content.toLowerCase() === exactContent)
      );
      if (p.get('order') === 'name') {
        matched = matched.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        if (p.get('direction') === 'desc') matched.reverse();
      } else {
        matched = matched.sort((a, b) => a.id.localeCompare(b.id));
      }
      const slice = matched.slice((page - 1) * perPage, page * perPage);
      return json({
        success: true,
        errors: [],
        result: slice.map((r) => ({ ...r, proxied: r.proxied ?? false })),
        result_info: {
          page,
          per_page: perPage,
          count: slice.length,
          total_count: matched.length,
          total_pages: Math.ceil(matched.length / perPage),
        },
      });
    }

    if (method === 'POST' && rest === '') {
      const body = JSON.parse(String(init?.body)) as FakeDnsRecord;
      const duplicate = [...records.values()].some(
        (r) => r.name === body.name && r.type === body.type && r.content === body.content
      );
      if (duplicate) return cfError(81058, 'An identical record already exists.', 400);
      const record = {
        id: `fake-${nextId++}`,
        name: body.name,
        type: body.type,
        content: body.content,
        proxied: body.proxied,
      };
      records.set(record.id, record);
      return json({ success: true, errors: [], result: record });
    }

    const id = rest.replace(/^\//, '');
    if (!id || id.includes('/')) return cfError(7003, 'Could not route', 404);
    const existing = records.get(id);
    if (method === 'DELETE') {
      if (!existing) return cfError(81044, 'Record does not exist.', 404);
      records.delete(id);
      return json({ success: true, errors: [], result: { id } });
    }
    if (method === 'PUT' || method === 'PATCH') {
      if (!existing) return cfError(81044, 'Record does not exist.', 404);
      const body = JSON.parse(String(init?.body)) as Partial<FakeDnsRecord>;
      records.set(id, { ...existing, ...body, id });
      return json({ success: true, errors: [], result: records.get(id) });
    }
    return cfError(7000, `Unsupported ${method}`, 405);
  }

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      // Yield so concurrent callers interleave across the await boundary.
      await Promise.resolve();
      return handle(input, init);
    },
    records,
    requests,
    names(): string[] {
      return [...records.values()].map((r) => r.name).sort();
    },
    byName(name: string): FakeDnsRecord[] {
      return [...records.values()].filter((r) => r.name === name);
    },
  };
}
