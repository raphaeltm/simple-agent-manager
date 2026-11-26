import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Header matched by the "SAM deploy checks" Cloudflare skip rule, which lets deploy workflows
 * through stricter zone protections. The workflow sets `DEPLOY_CHECK_HEADER_VALUE` from a GitHub
 * secret; without it nothing is added. Never log the value.
 */
const DEPLOY_CHECK_HEADER = 'x-sam-deploy-check';

/**
 * Headers for one direct API call (APIRequestContext) to the smoke-test app or API, empty when the
 * secret is not configured. Pass it per call, never as context-wide `extraHTTPHeaders`, so the
 * value is only ever sent to the deployment under test.
 */
export function deployCheckHeaders(): Record<string, string> {
  const value = process.env.DEPLOY_CHECK_HEADER_VALUE;
  return value ? { [DEPLOY_CHECK_HEADER]: value } : {};
}

function smokeOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const url of [process.env.SMOKE_TEST_URL, process.env.SMOKE_TEST_API_URL]) {
    if (url) origins.add(new URL(url).origin);
  }
  return origins;
}

export const test = base.extend({
  // Browser traffic gets the header by interception, not `extraHTTPHeaders`: a header the page
  // sends itself makes the app's cross-origin API calls preflight, and the API's CORS policy does
  // not allow it, so every API call would fail.
  context: async ({ context }, use) => {
    const headers = deployCheckHeaders();
    const origins = smokeOrigins();
    if (Object.keys(headers).length > 0 && origins.size > 0) {
      await context.route(
        (url) => origins.has(url.origin),
        (route) => route.continue({ headers: { ...route.request().headers(), ...headers } })
      );
    }
    await use(context);
  },
});
