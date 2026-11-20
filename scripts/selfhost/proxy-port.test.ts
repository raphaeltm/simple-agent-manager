import { describe, expect, it } from 'vitest';

import {
  BOX_LISTEN_ADDRESSES,
  BOX_RESERVED_PORTS,
  resolveTunnelPortRange,
} from './box-settings.js';
import { buildFencePlan } from './egress-fence.js';

const range = { start: 20000, end: 29999 };

describe('metadata proxy listener reservation', () => {
  it.each(['20000', '25000', '29999'])(
    'refuses configured proxy port %s in node leases',
    (port) => {
      expect(() => resolveTunnelPortRange({ GCE_METADATA_PROXY_PORT: port })).toThrow(
        /GCE_METADATA_PROXY_PORT/
      );
      expect(() =>
        buildFencePlan({
          box: { CELLD_BUCKET: 'gs://fleet', GCE_METADATA_PROXY_PORT: port },
          leaseRange: range,
          resolvConf: 'nameserver 127.0.0.53\n',
          objectStore: [],
        })
      ).toThrow(/metadata proxy.*lease/i);
    }
  );

  it('reserves the default proxy port even while its profile is off', () => {
    expect(() =>
      resolveTunnelPortRange({
        GCE_METADATA_PROXY: 'off',
        REVERSE_TUNNEL_PORT_RANGE_START: '7180',
        REVERSE_TUNNEL_PORT_RANGE_END: '7180',
      })
    ).toThrow(/GCE_METADATA_PROXY_PORT/);
  });

  it('accepts a proxy listener outside the lease range', () => {
    expect(resolveTunnelPortRange({ GCE_METADATA_PROXY_PORT: '30000' })).toEqual(range);
    const plan = buildFencePlan({
      box: { CELLD_BUCKET: 'gs://fleet', GCE_METADATA_PROXY_PORT: '30000' },
      leaseRange: range,
      resolvConf: 'nameserver 127.0.0.53\n',
      objectStore: [],
    });
    expect(plan.loopbackPorts).toContain(30000);
  });
});

describe('metadata broker and managed listener collisions', () => {
  it.each(Object.keys(BOX_RESERVED_PORTS).filter((name) => name !== 'GCE_METADATA_PROXY_PORT'))(
    'rejects broker overlap with %s',
    (name) => {
      const box = {
        CELLD_BUCKET: 'gs://fleet',
        GCE_METADATA_PROXY_PORT: '31000',
        [name]: BOX_LISTEN_ADDRESSES.includes(name) ? ':31000' : '31000',
      };
      expect(() => resolveTunnelPortRange(box)).toThrow(/collides/);
      expect(() =>
        buildFencePlan({
          box,
          leaseRange: range,
          resolvConf: 'nameserver 127.0.0.53\n',
          objectStore: [],
        })
      ).toThrow(/collides/);
    }
  );

  it('reserves disabled optional listener ports against future broker impersonation', () => {
    expect(() =>
      resolveTunnelPortRange({ GCE_METADATA_PROXY: 'off', GCE_METADATA_PROXY_PORT: '1025' })
    ).toThrow(/MAIL_COLLECTOR_SMTP_PORT/);
  });
});
