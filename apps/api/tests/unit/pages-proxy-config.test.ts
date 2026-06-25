import { describe, expect, it } from 'vitest';

import { resolvePagesProxyTarget } from '../../src/lib/pages-proxy';

describe('Pages proxy configuration', () => {
  it('fails visibly when app Pages project is not configured', async () => {
    const target = resolvePagesProxyTarget('app.example.com', { baseDomain: 'example.com' });

    expect(target).toEqual({
      type: 'missing-config',
      message: 'PAGES_PROJECT_NAME is not configured',
    });
  });

  it('proxies app subdomain to the configured Pages project', async () => {
    const target = resolvePagesProxyTarget('app.example.com', {
      baseDomain: 'example.com',
      appPagesProjectName: 'sa379a6-web-prod',
    });

    expect(target).toEqual({ type: 'proxy', hostname: 'sa379a6-web-prod.pages.dev' });
  });

  it('fails visibly when marketing Pages project is not configured', async () => {
    const target = resolvePagesProxyTarget('www.example.com', { baseDomain: 'example.com' });

    expect(target).toEqual({
      type: 'missing-config',
      message: 'WWW_PAGES_PROJECT_NAME is not configured',
    });
  });

  it('proxies www subdomain to the configured marketing Pages project', async () => {
    const target = resolvePagesProxyTarget('www.example.com', {
      baseDomain: 'example.com',
      wwwPagesProjectName: 'sa379a6-www',
    });

    expect(target).toEqual({ type: 'proxy', hostname: 'sa379a6-www.pages.dev' });
  });

  it('redirects apex requests to www', () => {
    const target = resolvePagesProxyTarget('example.com', { baseDomain: 'example.com' });

    expect(target).toEqual({ type: 'redirect', hostname: 'www.example.com' });
  });
});
