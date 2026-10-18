import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  cloudflareRequest,
  desiredApexRedirect,
  reconcileApexRedirect,
} from '../deploy/apex-redirect.mjs';

const domain = 'example.com';
const zoneId = 'a'.repeat(32);
const desired = desiredApexRedirect(domain);
function api(
  rules: Array<{ status?: string; [key: string]: unknown }> = [],
  overrides: Record<string, unknown> = {}
) {
  return vi
    .fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === `/zones/${zoneId}`) return { name: domain };
      if (path.includes('/dns_records')) return [{ name: domain, proxied: true, type: 'A' }];
      if (options?.method) return { id: 'rule-id', ...(options.body as object) };
      if (path.endsWith('status=disabled')) return rules.filter((r) => r.status === 'disabled');
      if (path.endsWith('status=active')) return rules.filter((r) => r.status === 'active');
      throw new Error(`Unexpected API request ${path}`);
    })
    .mockImplementationOnce(async () => ({ name: domain, ...overrides }));
}

describe('managed apex redirect', () => {
  it('uses the existing apex-only scheme-independent Page Rule contract', () => {
    expect(desired).toEqual({
      targets: [{ target: 'url', constraint: { operator: 'matches', value: 'example.com/*' } }],
      actions: [
        { id: 'forwarding_url', value: { url: 'https://www.example.com/$1', status_code: 301 } },
      ],
      status: 'active',
    });
    // Exercise Cloudflare's documented wildcard substitution, including raw query suffixes.
    for (const scheme of ['http', 'https']) {
      for (const suffix of ['', 'docs/', 'a%2Fb?x=1&x=2&q=a%20b&next=https%3A%2F%2Fexample.net']) {
        const source = new URL(`${scheme}://${domain}/${suffix}`);
        expect(
          desired.actions[0].value.url.replace('$1', source.pathname.slice(1) + source.search)
        ).toBe(`https://www.${domain}/${suffix}`);
      }
    }
    for (const host of [
      'www.example.com',
      'app.example.com',
      'api.example.com',
      'preview.example.com',
      'ws-id.example.com',
      'node.vm.example.com',
    ]) {
      expect(`${host}/`.startsWith(desired.targets[0].constraint.value.slice(0, -1))).toBe(false);
    }
  });

  it('plans creation without writes by default', async () => {
    const request = api();
    const plan = await reconcileApexRedirect({ domain, zoneId, request });
    expect(plan).toMatchObject({
      method: 'POST',
      path: `/zones/${zoneId}/pagerules`,
      after: desired,
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('creates exactly one rule when explicitly applied', async () => {
    const request = api();
    await reconcileApexRedirect({ domain, zoneId, request, apply: true });
    expect(request.mock.calls.filter(([, options]) => options?.method)).toEqual([
      [`/zones/${zoneId}/pagerules`, { method: 'POST', body: desired }],
    ]);
  });

  it('reactivates the disabled matching redirect without duplicating it or changing priority', async () => {
    const before = { ...desired, id: 'held-rule', status: 'disabled', priority: 7 };
    const request = api([before]);
    const plan = await reconcileApexRedirect({ domain, zoneId, request, apply: true });
    expect(plan).toMatchObject({
      method: 'PUT',
      path: `/zones/${zoneId}/pagerules/held-rule`,
      before,
      after: { ...desired, priority: 7 },
    });
  });

  it('makes no write when already correct, leaving unrelated rules intact', async () => {
    const request = api([
      { ...desired, id: 'current', priority: 3 },
      {
        ...desired,
        id: 'other',
        targets: [
          { target: 'url', constraint: { operator: 'matches', value: 'app.example.com/*' } },
        ],
      },
    ]);
    expect(await reconcileApexRedirect({ domain, zoneId, request, apply: true })).toMatchObject({
      method: null,
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('refuses duplicate rules or a matching rule with security actions', async () => {
    for (const rules of [
      [
        { ...desired, id: 'a' },
        { ...desired, id: 'b', status: 'disabled' },
      ],
      [{ ...desired, id: 'a', actions: [{ id: 'ssl', value: 'off' }] }],
    ]) {
      const request = api(rules);
      await expect(reconcileApexRedirect({ domain, zoneId, request, apply: true })).rejects.toThrow(
        /Ambiguous|non-redirect/
      );
      expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    }
  });

  it('fails before writes on wrong-zone or API errors', async () => {
    await expect(
      reconcileApexRedirect({
        domain,
        zoneId,
        request: api([], { name: 'other.com' }),
        apply: true,
      })
    ).rejects.toThrow(/zone/i);
    await expect(
      reconcileApexRedirect({
        domain,
        zoneId,
        request: vi.fn().mockRejectedValue(new Error('API denied')),
        apply: true,
      })
    ).rejects.toThrow('API denied');
  });

  it('rejects success:false even on HTTP200 without leaking response secrets', async () => {
    const canary = 'secret-canary-value';
    for (const response of [
      {
        ok: true,
        status: 200,
        json: async () => ({ success: false, errors: [{ message: canary }] }),
      },
      {
        ok: false,
        status: 403,
        json: async () => ({ success: false, errors: [{ message: canary }] }),
      },
      { ok: true, status: 200, json: async () => ({ success: true }) },
    ]) {
      const fetcher = vi.fn().mockResolvedValue(response);
      const request = cloudflareRequest('test-token', fetcher);
      await expect(reconcileApexRedirect({ domain, zoneId, request, apply: true })).rejects.toThrow(
        /Cloudflare GET .* failed/
      );
      await expect(
        reconcileApexRedirect({ domain, zoneId, request, apply: true })
      ).rejects.not.toThrow(canary);
      expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    }
  });

  it('runs the HTTP adapter through preflight and one exact redirect mutation', async () => {
    const results = [
      { name: domain },
      [{ name: domain, proxied: true, type: 'A' }],
      [],
      [],
      { id: 'created', ...desired },
    ];
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: results.shift() }),
    }));
    const plan = await reconcileApexRedirect({
      domain,
      zoneId,
      request: cloudflareRequest('test-token', fetcher),
      apply: true,
    });
    expect(plan.method).toBe('POST');
    const calls = fetcher.mock.calls as unknown as Array<
      [string, { method: string; body?: string }]
    >;
    expect(calls.map(([, options]) => options.method)).toEqual([
      'GET',
      'GET',
      'GET',
      'GET',
      'POST',
    ]);
    expect(calls.at(-1)?.[0]).toBe(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/pagerules`
    );
    expect(JSON.parse(calls.at(-1)?.[1].body ?? '{}')).toEqual(desired);
  });

  it('requires proxied apex DNS and refuses an unconfirmed write', async () => {
    const dnsRequest = api();
    dnsRequest
      .mockImplementationOnce(async () => ({ name: domain }))
      .mockImplementationOnce(async () => [{ name: domain, type: 'A', proxied: false }] as never);
    await expect(
      reconcileApexRedirect({ domain, zoneId, request: dnsRequest, apply: true })
    ).rejects.toThrow(/proxied DNS/);
    expect(dnsRequest.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    const request = api();
    const wrapper = async (path: string, options?: { method?: string; body?: unknown }) =>
      options?.method ? { id: 'wrong', status: 'disabled' } : request(path, options);
    await expect(
      reconcileApexRedirect({ domain, zoneId, request: wrapper, apply: true })
    ).rejects.toThrow(/did not confirm/);
  });

  it('exposes a manual redirect-only plan without provisioning DNS, Pages, Worker or TLS resources', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/provision-www.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('default: plan-redirect');
    expect(workflow).toContain('group: www-infra');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('node scripts/deploy/apex-redirect.mjs');
    for (const name of [
      'Create Pages Project',
      'Create DNS Records',
      'Add Custom Domain to Pages Project',
    ]) {
      expect(workflow).toContain(`- name: ${name}\n        if: inputs.operation == 'provision'`);
    }
    const provision = readFileSync(
      new URL('../../.github/workflows/provision-www.yml', import.meta.url),
      'utf8'
    );
    expect(provision).toContain('node scripts/deploy/apex-redirect.mjs --apply');
    expect(provision).not.toContain('pagerules?status=active');
  });
});
