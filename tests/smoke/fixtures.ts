import { test as base } from '@playwright/test';

import { deployCheckHeaders } from './deploy-check';

export { deployCheckConfigured, deployCheckFetch } from './deploy-check';
export { expect } from '@playwright/test';

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
