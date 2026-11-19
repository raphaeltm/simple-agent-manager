/**
 * The self-host box's Caddy access log (deploy/selfhost/caddy/log-redaction.caddy) replaces a
 * credential that a route carries in its path. This scans the app's client routes (App.tsx: the
 * box serves the app's HTML document for them, so they reach the access log) for path parameters
 * named like a credential, so a new one fails here until the redaction filter and this list cover
 * it. The API routes have the same guard in
 * apps/api/tests/unit/selfhost/caddy-log-redaction-routes.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname, '../../src/App.tsx');
const REDACTION = resolve(__dirname, '../../../../deploy/selfhost/caddy/log-redaction.caddy');

/** `<Route path="...">` values with a path parameter named like a credential. */
const CREDENTIAL_ROUTE =
  /path=\s*['"`]([^'"`]*\/:(?:[a-z]*token|sig|signature|secret|key|code|jwt|nonce)\b[^'"`]*)['"`]/gi;

/** Each known credential route and the logged path prefix the redaction filter rewrites. */
const KNOWN_CREDENTIAL_ROUTES: Record<string, string> = {
  '/projects/invite/:token': '/projects/invite/',
};

describe('self-host access log: path credentials in app routes', () => {
  it('every app route with a credential in its path is on the redaction list', () => {
    const found = [...readFileSync(APP, 'utf8').matchAll(CREDENTIAL_ROUTE)].map((m) => m[1]);
    expect(found.sort()).toEqual(Object.keys(KNOWN_CREDENTIAL_ROUTES).sort());
  });

  it('log-redaction.caddy rewrites the prefix each of those routes is served under', () => {
    const rule = /regexp "\^\(([^)"]+)\)\[\^\/\?\]\*" "\$\{1\}<redacted>"/.exec(
      readFileSync(REDACTION, 'utf8')
    );
    const prefixes = rule?.[1]?.split('|') ?? [];
    expect(prefixes.length).toBeGreaterThan(0); // the rule was found
    for (const prefix of Object.values(KNOWN_CREDENTIAL_ROUTES)) {
      expect(prefixes).toContain(prefix);
    }
  });
});
