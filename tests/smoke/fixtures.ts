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
 * secret is not configured. Pass it per call, never as context-wide `extraHTTPHeaders`, and with
 * `maxRedirects: 0`, so the value (and any request body) is only ever sent to the deployment under
 * test, never carried along a redirect.
 */
export function deployCheckHeaders(): Record<string, string> {
  const value = process.env.DEPLOY_CHECK_HEADER_VALUE;
  return value ? { [DEPLOY_CHECK_HEADER]: value } : {};
}

/** The deployment under test, over HTTPS only: the header is never sent in cleartext. */
function smokeOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const url of [process.env.SMOKE_TEST_URL, process.env.SMOKE_TEST_API_URL]) {
    if (url && new URL(url).protocol === 'https:') origins.add(new URL(url).origin);
  }
  return origins;
}

export const test = base.extend({
  // Browser traffic gets the header by interception, not `extraHTTPHeaders`: a header the page
  // sends itself makes the app's cross-origin API calls preflight, and the API's CORS policy does
  // not allow it, so every API call would fail.
  //
  // The request is fetched without following redirects and the browser is handed the response.
  // `route.continue()` would apply the header to every hop of a redirect chain, while the handler
  // only sees the first URL, so a redirect to another host would carry the secret there. Handed a
  // 3xx, the browser follows it itself and the route is not invoked again, so the next hop goes out
  // without the header, even on a smoke origin. That fails closed: a redirecting hop may be
  // challenged, but the secret never follows it.
  // A failed fetch aborts the request instead of leaving it pending; never fall back to
  // `route.continue()` with the header. Fetching buffers the response, which is fine for the smoke
  // tests: none of them stream.
  context: async ({ context }, use) => {
    const headers = deployCheckHeaders();
    const origins = smokeOrigins();
    if (Object.keys(headers).length > 0 && origins.size > 0) {
      await context.route(
        (url) => origins.has(url.origin),
        async (route) => {
          let response;
          try {
            response = await route.fetch({
              headers: { ...route.request().headers(), ...headers },
              maxRedirects: 0,
            });
          } catch {
            // The error's call log lists the request headers, the secret included: drop it.
            await route.abort('failed');
            return;
          }
          await route.fulfill({ response });
        }
      );
    }
    await use(context);
  },
});
