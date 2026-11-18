import { beforeAll, describe, expect, it, vi } from 'vitest';
import { findRegisteredResource } from './setup';

vi.mock('../resources/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resources/config')>();
  return {
    ...actual,
    baseDomain: 'sam.team.example.com',
    zoneName: 'example.com',
    workersDevSubdomain: 'existing-account',
  };
});

describe('nested installation DNS', () => {
  let config: typeof import('../resources/config');
  beforeAll(async () => {
    config = await import('../resources/config');
    await import('../resources/dns');
  });
  it('places each record under the selected installation subdomain and preserves the account hostname', () => {
    for (const [resource, label] of [
      ['api', 'api'],
      ['app', 'app'],
      ['preview', 'preview'],
      ['wildcard', '*'],
    ]) {
      const record = findRegisteredResource(
        `${config.prefix}-dns-${resource}`,
        'cloudflare:index/record:Record'
      );
      expect(record.inputs.name).toBe(`${label}.sam.team`);
      if (resource !== 'app')
        expect(record.inputs.content).toBe(
          `${config.prefix}-api-${config.stack}.existing-account.workers.dev`
        );
    }
    expect(
      findRegisteredResource(
        `${config.prefix}-route-vm-exclusion`,
        'cloudflare:index/workersRoute:WorkersRoute'
      ).inputs.pattern
    ).toBe('*.vm.sam.team.example.com/*');
  });
});
