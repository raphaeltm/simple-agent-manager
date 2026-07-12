import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

import { findRegisteredResource } from './setup';

pulumi.runtime.setConfig('project:baseDomain', 'dev-a.example.com');

describe('nested deployment domain resource wiring', () => {
  let configModule: typeof import('../resources/config');

  beforeAll(async () => {
    configModule = await import('../resources/config');
    await import('../resources/dns');
    await import('../resources/pages');
    await import('../resources/origin-ca');
  });

  it('wires the same nested hostname namespace through DNS, Pages, routes, and Origin CA', () => {
    expect(
      findRegisteredResource(`${configModule.prefix}-dns-api`, 'cloudflare:index/record:Record')
        .inputs.name
    ).toBe('api.dev-a.example.com');
    expect(
      findRegisteredResource(
        `${configModule.prefix}-dns-wildcard`,
        'cloudflare:index/record:Record'
      ).inputs.name
    ).toBe('*.dev-a.example.com');
    expect(
      findRegisteredResource(
        `${configModule.prefix}-pages-domain`,
        'cloudflare:index/pagesDomain:PagesDomain'
      ).inputs.name
    ).toBe('app.dev-a.example.com');
    expect(
      findRegisteredResource(
        `${configModule.prefix}-route-vm-exclusion`,
        'cloudflare:index/workersRoute:WorkersRoute'
      ).inputs.pattern
    ).toBe('*.vm.dev-a.example.com/*');
    expect(
      findRegisteredResource(
        'origin-ca-cert',
        'cloudflare:index/originCaCertificate:OriginCaCertificate'
      ).inputs.hostnames
    ).toEqual(['*.dev-a.example.com', '*.vm.dev-a.example.com', 'dev-a.example.com']);
  });
});
