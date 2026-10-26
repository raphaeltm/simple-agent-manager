import { describe, expect, it, vi } from 'vitest';

import { planRoutingSpf } from '../../../src/services/agent-email/setup-spf';
import { verifySpfLookupBudget } from '../../../src/services/agent-email/setup-spf-lookups';

describe('SPF setup safety', () => {
  it('verifies the real Google and Cloudflare include names', async () => {
    const lookup = vi.fn(async () => 'v=spf1 ip4:192.0.2.0/24 -all');
    await expect(
      verifySpfLookupBudget(
        'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all',
        lookup
      )
    ).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith('_spf.google.com');
    expect(lookup).toHaveBeenCalledWith('_spf.mx.cloudflare.net');
  });
  it('retains Google authorization for both current and legacy MX names', () => {
    for (const content of ['smtp.google.com', 'ASPMX.L.GOOGLE.COM.', 'alt4.aspmx.l.google.com']) {
      expect(planRoutingSpf([{ type: 'MX', content }])).toEqual({
        before: null,
        after: 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all',
      });
    }
  });
  it('preserves a policy already authorizing Cloudflare', () => {
    const content = 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all';
    expect(planRoutingSpf([{ type: 'TXT', content }])).toEqual({ before: content, after: content });
  });
  it('counts nested includes, not only the top level', async () => {
    const lookup = vi.fn(async (domain: string) => {
      const n = Number(domain.split('.')[0]?.slice(1));
      return n === 10 ? 'v=spf1 ip4:192.0.2.1 -all' : `v=spf1 include:n${n + 1}.example -all`;
    });
    await expect(
      verifySpfLookupBudget('v=spf1 include:n1.example -all', lookup)
    ).resolves.toBeUndefined();
    await expect(
      verifySpfLookupBudget('v=spf1 include:n1.example include:extra.example -all', lookup)
    ).rejects.toThrow('10 DNS lookup');
  });
  it('rejects recursive policies and unsupported macros before DNS writes', async () => {
    await expect(
      verifySpfLookupBudget(
        'v=spf1 include:loop.example -all',
        async () => 'v=spf1 include:loop.example -all'
      )
    ).rejects.toThrow('loop');
    const lookup = vi.fn();
    await expect(verifySpfLookupBudget('v=spf1 include:%{i}.example -all', lookup)).rejects.toThrow(
      'cannot safely verify'
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
