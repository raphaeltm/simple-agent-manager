import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildFencePlan, renderFenceRuleset } from './egress-fence.js';
import { writeFenceFiles } from './fence-state.js';
import { mailEgressEndpoints } from './mail-settings.js';
const RANGE = { start: 20000, end: 29999 };
const RESOLV = 'nameserver 127.0.0.53\n';
mkdirSync(resolve('.tmp'), { recursive: true });

describe('rendered SMTP relay fence', () => {
  it.each(['127.0.0.2', '10.42.0.5'])(
    'opens only the configured %s relay endpoint',
    async (host) => {
      const stateDir = mkdtempSync(resolve('.tmp/smtp-fence-'));
      await writeFenceFiles({
        stateDir,
        box: { SMTP_HOST: host, SMTP_PORT: '2525', SMTP_FROM: 'sign-in@sam.example.com' },
        leaseRange: RANGE,
        resolvConf: RESOLV,
      });
      const rules = readFileSync(join(stateDir, 'egress-fence.nft'), 'utf8');
      expect(rules).toContain(`ip daddr ${host} tcp dport 2525 accept`);
      expect(rules).not.toContain(`ip daddr ${host} tcp dport 2526 accept`);
      expect(rules).not.toContain(`ip daddr ${host} udp dport 2525 accept`);
    }
  );

  it.each([
    ['127.0.0.1', '2019'],
    ['169.254.169.254', '587'],
    ['[fe80::1]', '587'],
  ])('refuses a forbidden relay endpoint %s:%s before writing rules', async (host, port) => {
    const stateDir = mkdtempSync(resolve('.tmp/smtp-fence-'));
    await expect(
      writeFenceFiles({
        stateDir,
        box: { SMTP_HOST: host, SMTP_PORT: port, SMTP_FROM: 'sign-in@sam.example.com' },
        leaseRange: RANGE,
        resolvConf: RESOLV,
      })
    ).rejects.toThrow();
  });
});

describe('DNS SMTP relay fence', () => {
  it.each([
    [['10.42.0.5', 'fd00::5'], '2465', false],
    [['10.42.0.5', '169.254.169.254'], '587', true],
    [['fd20:ce::254'], '587', true],
    [['127.0.0.1'], '2019', true],
  ] as const)(
    'validates all resolved endpoints %o:%s centrally',
    async (addresses, port, forbidden) => {
      const box = {
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: port,
        SMTP_FROM: 'sign-in@sam.example.com',
      };
      const serviceEndpoints = await mailEgressEndpoints(box, async () => [...addresses]);
      const build = () =>
        buildFencePlan({
          box,
          leaseRange: RANGE,
          resolvConf: RESOLV,
          objectStore: [],
          serviceEndpoints,
        });
      if (forbidden) {
        expect(build).toThrow();
      } else {
        const rules = renderFenceRuleset(build());
        expect(rules).toContain('ip daddr 10.42.0.5 tcp dport 2465 accept');
        expect(rules).toContain('ip6 daddr fd00::5 tcp dport 2465 accept');
      }
    }
  );
});
