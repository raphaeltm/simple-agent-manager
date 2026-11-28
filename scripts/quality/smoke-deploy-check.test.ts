import type { APIRequestContext } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';

import { deployCheckFetch } from '../../tests/smoke/deploy-check';

const SECRET = 'DEPLOY_CHECK_CANARY_7f3a';

function fakeRequest(behaviour: (url: string, options: Record<string, unknown>) => unknown) {
  const calls: { url: string; options: Record<string, unknown> }[] = [];
  const request = {
    fetch: async (url: string, options: Record<string, unknown>) => {
      calls.push({ url, options });
      return behaviour(url, options);
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

describe('smoke-test deploy-check API helper', () => {
  afterEach(() => {
    delete process.env.DEPLOY_CHECK_HEADER_VALUE;
  });

  it('sends the header with redirects disabled, keeping the caller options', async () => {
    process.env.DEPLOY_CHECK_HEADER_VALUE = SECRET;
    const { request, calls } = fakeRequest(() => 'response');
    await expect(
      deployCheckFetch(request, 'https://api.example.test/api/auth/token-login', {
        method: 'POST',
        data: { token: 't' },
        headers: { 'Content-Type': 'application/json' },
        maxRedirects: 5,
      })
    ).resolves.toBe('response');
    expect(calls).toEqual([
      {
        url: 'https://api.example.test/api/auth/token-login',
        options: {
          method: 'POST',
          data: { token: 't' },
          headers: { 'Content-Type': 'application/json', 'x-sam-deploy-check': SECRET },
          maxRedirects: 0,
        },
      },
    ]);
  });

  it('rethrows a failed call without the secret Playwright puts in its call log', async () => {
    process.env.DEPLOY_CHECK_HEADER_VALUE = SECRET;
    const { request } = fakeRequest(() => {
      throw new Error(
        `apiRequestContext.fetch: connect ETIMEDOUT\nCall log:\n  - → GET https://api.example.test/health\n    - x-sam-deploy-check: ${SECRET}\n    - x-again: ${SECRET}`
      );
    });
    const failure = await deployCheckFetch(request, 'https://api.example.test/health').catch(
      (error: Error) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('connect ETIMEDOUT');
    expect((failure as Error).message).toContain('x-sam-deploy-check: [deploy-check header]');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(SECRET);
    expect((failure as Error).cause).toBeUndefined();
  });

  it('adds nothing and changes no error when the secret is not configured', async () => {
    const { request, calls } = fakeRequest(() => {
      throw new Error('apiRequestContext.fetch: getaddrinfo ENOTFOUND');
    });
    await expect(deployCheckFetch(request, 'https://api.example.test/health')).rejects.toThrow(
      'apiRequestContext.fetch: getaddrinfo ENOTFOUND'
    );
    expect(calls[0].options).toEqual({ headers: {}, maxRedirects: 0 });
  });
});
