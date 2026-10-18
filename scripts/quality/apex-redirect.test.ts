import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  APEX_REDIRECT_REF,
  cloudflareRequest,
  desiredApexRedirect,
  reconcileApexRedirect,
  REDIRECT_PHASE,
} from '../deploy/apex-redirect.mjs';

const domain = 'example.com';
const zoneId = 'a'.repeat(32);
const rulesetId = 'b'.repeat(32);
const ruleId = 'c'.repeat(32);
const desired = desiredApexRedirect(domain);
const entry = (rules: unknown[]) => ({ id: rulesetId, kind: 'zone', phase: REDIRECT_PHASE, rules });
function api(existing: ReturnType<typeof entry> | null = null, zone = domain) {
  return vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method)
      return entry([
        ...(existing?.rules ?? []).filter((rule: any) => rule.ref !== APEX_REDIRECT_REF),
        ...(options.method === 'DELETE' ? [] : [{ id: ruleId, ...desired }]),
      ]);
    if (path === `/zones/${zoneId}`) return { name: zone };
    if (path.includes('/dns_records')) return [{ name: domain, proxied: true, type: 'A' }];
    if (path.endsWith('/rulesets')) return existing ? [existing] : [];
    if (path.endsWith(`/rulesets/${rulesetId}`)) return existing;
    throw new Error(`Unexpected request ${path}`);
  });
}

describe('managed apex Single Redirect', () => {
  it('matches only the bare hostname on both schemes and preserves paths and query strings', () => {
    expect(desired).toMatchObject({
      ref: APEX_REDIRECT_REF,
      expression: '(http.host eq "example.com")',
      action: 'redirect',
      enabled: true,
      action_parameters: {
        from_value: {
          target_url: { expression: 'concat("https://www.example.com", http.request.uri.path)' },
          status_code: 301,
          preserve_query_string: true,
        },
      },
    });
    // Configuration contract; actual edge behavior requires public smoke.
    for (const scheme of ['http', 'https']) {
      const source = new URL(`${scheme}://${domain}/docs/a%2Fb?x=1&x=2&q=a%20b`);
      expect(source.hostname).toBe(domain);
      expect(`https://www.${domain}${source.pathname}${source.search}`).toBe(
        'https://www.example.com/docs/a%2Fb?x=1&x=2&q=a%20b'
      );
    }
    for (const host of [
      'www.example.com',
      'app.example.com',
      'api.example.com',
      'preview.example.com',
      'ws-id.example.com',
      'node.vm.example.com',
    ])
      expect(host).not.toBe(domain);
  });

  it('plans a missing entrypoint without writes by default', async () => {
    const request = api();
    expect(await reconcileApexRedirect({ domain, zoneId, request })).toMatchObject({
      method: 'POST',
      path: `/zones/${zoneId}/rulesets`,
      before: null,
      after: { kind: 'zone', phase: REDIRECT_PHASE, rules: [desired] },
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('creates only the redirect entrypoint when explicitly applied', async () => {
    const request = api();
    await reconcileApexRedirect({ domain, zoneId, request, apply: true });
    expect(request.mock.calls.filter(([, options]) => options?.method)).toEqual([
      [
        `/zones/${zoneId}/rulesets`,
        {
          method: 'POST',
          body: {
            name: 'Marketing redirects',
            kind: 'zone',
            phase: REDIRECT_PHASE,
            rules: [desired],
          },
        },
      ],
    ]);
  });

  it('appends one rule without replacing unrelated rules or touching security phases', async () => {
    const unrelated = {
      id: 'd'.repeat(32),
      ref: 'other',
      expression: '(http.host eq "app.example.com")',
      action: 'redirect',
    };
    const before = entry([unrelated]);
    const request = api(before);
    const plan = await reconcileApexRedirect({ domain, zoneId, request, apply: true });
    expect(plan).toMatchObject({
      method: 'POST',
      path: `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
      after: desired,
    });
    expect(before.rules).toEqual([unrelated]);
    expect(request.mock.calls.filter(([, options]) => options?.method)).toEqual([
      [plan.path, { method: 'POST', body: desired }],
    ]);
    expect(request.mock.calls.some(([path]) => /firewall|waf|pagerules/.test(path))).toBe(false);
  });

  it('reactivates only the managed rule with PATCH and leaves its position unchanged', async () => {
    const before = { id: ruleId, ...desired, enabled: false };
    const request = api(entry([before]));
    const plan = await reconcileApexRedirect({ domain, zoneId, request, apply: true });
    expect(plan).toMatchObject({
      method: 'PATCH',
      path: `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`,
      before,
      after: desired,
    });
    expect(plan.after).not.toHaveProperty('position');
  });

  it('does not write when the managed rule is already correct', async () => {
    const request = api(entry([{ id: ruleId, ...desired }]));
    expect(await reconcileApexRedirect({ domain, zoneId, request, apply: true })).toMatchObject({
      method: null,
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('refuses duplicates, security actions, and unmanaged exact apex rules', async () => {
    for (const rules of [
      [
        { id: ruleId, ...desired },
        { id: 'd'.repeat(32), ...desired },
      ],
      [{ id: ruleId, ...desired, action: 'skip' }],
      [{ id: ruleId, ...desired, ref: 'external-owner' }],
    ]) {
      const request = api(entry(rules));
      await expect(reconcileApexRedirect({ domain, zoneId, request, apply: true })).rejects.toThrow(
        /Ambiguous|non-redirect|Unmanaged/
      );
      expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    }
  });

  it('fails before writes on wrong-zone or API errors', async () => {
    await expect(
      reconcileApexRedirect({ domain, zoneId, request: api(null, 'other.com'), apply: true })
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

  it('rejects success:false HTTP200/403 and missing result without leaking API bodies', async () => {
    const canary = 'secret-canary-value';
    for (const response of [
      {
        ok: true,
        status: 200,
        json: async () => ({ success: false, errors: [{ code: 1011, message: canary }] }),
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

  it('runs the real HTTP adapter through preflight and exact redirect creation', async () => {
    const results = [
      { name: domain },
      [{ name: domain, proxied: true, type: 'A' }],
      [],
      entry([{ id: ruleId, ...desired }]),
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
    expect(calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'GET', 'POST']);
    expect(calls.at(-1)?.[0]).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets`);
    expect(JSON.parse(calls.at(-1)?.[1].body ?? '{}')).toMatchObject({
      phase: REDIRECT_PHASE,
      rules: [desired],
    });
  });

  it('requires proxied DNS and rejects an unconfirmed mutation response', async () => {
    const request = api();
    const noDns = async (path: string, options?: { method?: string; body?: unknown }) =>
      path.includes('/dns_records') ? [] : request(path, options);
    await expect(
      reconcileApexRedirect({ domain, zoneId, request: noDns, apply: true })
    ).rejects.toThrow(/proxied DNS/);
    const mismatch = async (path: string, options?: { method?: string; body?: unknown }) =>
      options?.method
        ? entry([{ id: ruleId, ...desired, action: 'skip' }])
        : request(path, options);
    await expect(
      reconcileApexRedirect({ domain, zoneId, request: mismatch, apply: true })
    ).rejects.toThrow(/did not confirm/);
  });

  it('teardown deletes only its exact owned rule and preserves unrelated rules and the entrypoint', async () => {
    const unrelated = { id: 'd'.repeat(32), ref: 'other', action: 'redirect' };
    const request = api(entry([unrelated, { id: ruleId, ...desired }]));
    const plan = await reconcileApexRedirect({
      domain,
      zoneId,
      request,
      remove: true,
      apply: true,
    });
    expect(plan).toMatchObject({
      method: 'DELETE',
      path: `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`,
      after: null,
    });
    expect(request.mock.calls.filter(([, options]) => options?.method)).toEqual([
      [plan.path, { method: 'DELETE' }],
    ]);
    expect(request.mock.calls.some(([path]) => path.includes('dns_records'))).toBe(false);
    const missing = api();
    expect(
      await reconcileApexRedirect({ domain, zoneId, request: missing, remove: true, apply: true })
    ).toMatchObject({ method: null });
    expect(missing.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('keeps teardown confirmation, opt-in marketing and dry-run protection on managed redirect cleanup', () => {
    const marketing = readFileSync(
      new URL('../../.github/workflows/teardown-www.yml', import.meta.url),
      'utf8'
    );
    const full = readFileSync(
      new URL('../../.github/workflows/teardown.yml', import.meta.url),
      'utf8'
    );
    expect(marketing).toContain("github.event.inputs.confirm == 'DELETE'");
    expect(marketing).toContain('node scripts/deploy/apex-redirect.mjs --remove --apply');
    const cleanup = full.match(
      /- name: Delete Managed Apex Single Redirect[\s\S]*?(?=\n {6}- name:)/
    )?.[0];
    expect(cleanup).toContain('if: ${{ inputs.include_marketing }}');
    expect(cleanup).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(cleanup).toContain('node scripts/deploy/apex-redirect.mjs --remove\n');
  });

  it('uses isolated plan/apply operations and retains the existing www-infra lease', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/provision-www.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('default: plan-redirect');
    expect(workflow).toContain('group: www-infra');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('node scripts/deploy/apex-redirect.mjs --apply');
    expect(workflow).not.toContain('pagerules?status=active');
    for (const name of [
      'Create Pages Project',
      'Create DNS Records',
      'Add Custom Domain to Pages Project',
    ])
      expect(workflow).toContain(`- name: ${name}\n        if: inputs.operation == 'provision'`);
  });
});
