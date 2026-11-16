# sam/no-unguarded-outbound-fetch

Requires outbound requests from API Worker source to go through `guardedFetch`
(`@simple-agent-manager/worker-core`) when someone other than the code author chooses the URL: a
user's credential base URL, a web push endpoint, a registry named in a deployment manifest, a
redirect from a remote server.

`guardedFetch` classifies the host before the request (`classifyHost`: public, private or
forbidden, in every IPv4/IPv6 literal spelling), never lets the runtime follow a redirect, and
re-checks every hop.

## What it matches

Every value reference to the runtime's global `fetch`, however it is spelled:

- `fetch(url)`, `(0, fetch)(url)`, `fetch.call(...)`, `Reflect.apply(fetch, ...)`
- `globalThis.fetch(url)`, `self['fetch'](url)`, `globalThis?.fetch(url)`
- `fetch` passed or stored as a value (`{ fetchFn: fetch }`, `const f = fetch`)
- `import ... from 'cloudflare:sockets'` and `import('cloudflare:sockets')`

It does not match binding or Durable Object stub calls (`env.ASSETS.fetch`, `stub.fetch`), a local
variable or parameter named `fetch`, or `typeof fetch` in a type position.

Scope: `apps/api/src` and the `src` of every package the Worker bundles
(`packages/eslint-plugin-sam/outbound-fetch-scope.js`). Tests are not checked.

## Stage: ratchet

The rule is `error`, with a per-file baseline (`outbound-fetch-baseline.json`) holding every
global-fetch site that existed when the rule landed (44 sites in 32 files, 2026-11-15). A file may
not exceed its baseline, and a file that drops below it must lower it, so the count only goes
down. This is the repository's progressive-rollout shape for new rules (existing debt ratcheted,
new occurrences blocking) without touching every existing call site in one change.

## Adding a request

- URL chosen by a user, an admin or a remote server: call `guardedFetch` (or check it with
  `assertOutboundUrl` before a request that must stay on its own `fetch`, and pass
  `redirect: 'manual'`).
- URL fixed by the code (the Cloudflare API, a cloud provider's API, a host SAM derives from
  `BASE_DOMAIN`): acknowledge it inline, naming who chooses the URL:

  ```ts
  // eslint-disable-next-line sam/no-unguarded-outbound-fetch -- Cloudflare API, fixed by code
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`);
  ```

  Acknowledged sites do not count against the baseline. Do not raise a baseline number to make
  room for a new site.

After guarding existing sites, lower the baseline:

```bash
node packages/eslint-plugin-sam/scripts/outbound-fetch-baseline.mjs --write
```

## Known gaps

- A wrapper (`fetchWithTimeout`, `providerFetch`) is counted once, at its own global-fetch site.
  A new call through an existing wrapper is not flagged; those wrappers serve URLs the code
  fixes, and a user-chosen URL must not be passed to them.
- An SDK constructed with a user-chosen `baseURL` sends requests the rule cannot see. Give such an
  SDK a `fetch` option bound to `guardedFetch`.
- The host check sees names, not DNS answers: a public name that resolves to a private address
  passes. See the header of `packages/worker-core/src/network-hosts/classify.ts`.
