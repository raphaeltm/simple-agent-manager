/**
 * Static wiring for Caddy's access log and the keep-warm health check (the behaviour itself is
 * proven against the real Caddy image in live/access-log-keep-warm.live.test.ts): compose passes
 * the keep-warm settings with their defaults and caps the Caddy log on disk, and both Caddy
 * loggers import the one redaction filter. Which path prefixes the filter rewrites is pinned against
 * the routes themselves in apps/api/tests/unit/selfhost/caddy-log-redaction-routes.test.ts, which CI
 * runs on route changes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = resolve(import.meta.dirname, '../..');
const SELFHOST = resolve(REPO, 'deploy/selfhost');

interface Service {
  environment?: Record<string, string>;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  read_only?: boolean;
  tmpfs?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
}

const compose = parse(readFileSync(`${SELFHOST}/docker-compose.yml`, 'utf8')) as {
  services: Record<string, Service>;
};
const caddy = compose.services.caddy;
const caddyfile = readFileSync(`${SELFHOST}/caddy/Caddyfile`, 'utf8');
const redaction = readFileSync(`${SELFHOST}/caddy/log-redaction.caddy`, 'utf8');
const keepWarm = readFileSync(`${SELFHOST}/caddy/keep-warm/on.caddy`, 'utf8');

describe('Caddy logging and keep-warm wiring', () => {
  it('passes keep-warm on by default, at 5 s', () => {
    expect(caddy?.environment?.SAM_KEEP_WARM).toBe('${SAM_KEEP_WARM:-on}');
    expect(caddy?.environment?.SAM_KEEP_WARM_INTERVAL).toBe('${SAM_KEEP_WARM_INTERVAL:-5s}');
  });

  it('caps the Caddy log on disk', () => {
    expect(caddy?.logging?.driver).toBe('json-file');
    expect(caddy?.logging?.options?.['max-size']).toBe('${CADDY_LOG_MAX_SIZE:-50m}');
    expect(caddy?.logging?.options?.['max-file']).toBe('${CADDY_LOG_MAX_FILES:-5}');
  });

  it('applies the one redaction filter to the access log and to Caddy own log', () => {
    expect(caddyfile.match(/import log-redaction\.caddy/g)).toHaveLength(2);
    expect(caddyfile).toMatch(/log default \{\s*output stderr\s*import log-redaction\.caddy/);
    expect(caddyfile).toMatch(/\tlog \{\s*output stdout\s*import log-redaction\.caddy/);
  });

  it('the redaction filter drops headers, query strings and preview paths', () => {
    expect(redaction).toMatch(/^\trequest>headers delete$/m);
    expect(redaction).toMatch(/^\tresp_headers delete$/m);
    expect(redaction).toMatch(/^\theaders delete$/m);
    expect(redaction).toContain('\t\tregexp "\\?.*$" "?<redacted>"');
    expect(redaction).toContain('\t\tregexp "^/p/[^?]*" "/p/<redacted>"');
  });

  it('keeps the keep-warm check on a route that never serves a request', () => {
    expect(caddyfile).toContain('import keep-warm/{$SAM_KEEP_WARM:on}.caddy');
    expect(keepWarm).toMatch(/^@sam_keep_warm expression false$/m);
    expect(keepWarm).toContain('handle @sam_keep_warm {');
    expect(keepWarm).toContain('health_uri /health');
    expect(keepWarm).toContain('health_interval {$SAM_KEEP_WARM_INTERVAL:5s}');
  });
});

// Every long-running box service on the host network runs without capabilities it does not need.
// celld and frps listen only on loopback ports above 1023, so they need none; Caddy keeps only
// NET_BIND_SERVICE for 80/443. Read-only roots: frps writes no file (frps.toml logs to the
// console); celld writes only its CELLD_WATCH volume (checked on the pinned image).
describe('box service privileges', () => {
  it.each(['celld', 'frps'])('%s drops every capability and cannot gain one', (name) => {
    const service = compose.services[name];
    expect(service?.cap_drop).toEqual(['ALL']);
    expect(service?.cap_add).toBeUndefined();
    expect(service?.security_opt).toEqual(['no-new-privileges:true']);
    expect(service?.read_only).toBe(true);
  });

  it('celld writes only its data volume and a tmpfs /tmp', () => {
    const celld = compose.services.celld as Service & { volumes?: string[] };
    expect(celld.tmpfs).toEqual(['/tmp']);
    expect(celld.volumes).toEqual(['celld-data:/var/lib/celld']);
    expect(celld.environment?.CELLD_WATCH).toBe('/var/lib/celld');
  });

  it('control: Caddy keeps only NET_BIND_SERVICE, for 80 and 443', () => {
    expect(caddy?.cap_drop).toEqual(['ALL']);
    expect(caddy?.cap_add).toEqual(['NET_BIND_SERVICE']);
  });
});
