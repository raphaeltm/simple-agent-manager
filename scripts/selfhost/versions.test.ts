import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { celldReleaseTarget } from './celld-binary.js';
import { CELLD_RELEASE_SHA256, CELLD_VERSION } from './versions.js';

const SELFHOST = resolve(import.meta.dirname, '../../deploy/selfhost');
const read = (path: string) => readFileSync(resolve(SELFHOST, path), 'utf8');
const COMPOSE = read('docker-compose.yml');

interface Service {
  image?: string;
  build?: string | { context: string; args?: Record<string, string> };
  pull_policy?: string;
}
const services = (parse(COMPOSE) as { services: Record<string, Service> }).services;

/** Locally built images and their Dockerfiles. */
const LOCAL: Record<string, string> = {
  'sam-selfhost-caddy:local': 'caddy/Dockerfile',
  'sam-selfhost-sam-mx:local': 'sam-mx/Dockerfile',
  'sam-selfhost-sam-dns:local': 'sam-dns/Dockerfile',
  'sam-selfhost-egress-fence:local': 'egress-fence/Dockerfile',
  'sam-selfhost-metadata-proxy:local': 'metadata-proxy/Dockerfile',
  'sam-selfhost-key-agent:local': 'key-agent/Dockerfile',
};

describe('pinned versions', () => {
  it('deploys with the same celld version the compose stack runs', () => {
    const image = /image:\s*ghcr\.io\/denoland\/celld:v([0-9.]+)@sha256:[0-9a-f]{64}/.exec(COMPOSE);
    expect(image?.[1]).toBe(CELLD_VERSION);
  });

  it('pins every pulled compose image by digest, and every Dockerfile base image', () => {
    const images = Object.values(services).map((service) => service.image ?? '');
    const pulled = images.filter((image) => !(image in LOCAL));
    expect(pulled.length).toBeGreaterThanOrEqual(4);
    for (const image of pulled) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    for (const dockerfilePath of Object.values(LOCAL)) {
      const froms = [...read(dockerfilePath).matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
      expect(froms.length, dockerfilePath).toBeGreaterThanOrEqual(1);
      for (const from of froms) expect(from, dockerfilePath).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('has a checksum for every release target it can select', () => {
    for (const [os, cpu] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'arm64'],
    ] as const) {
      expect(CELLD_RELEASE_SHA256[celldReleaseTarget(os, cpu)]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(() => celldReleaseTarget('win32', 'x64')).toThrow(/set CELLD_BIN/);
  });
});

// F11 (#2666): image builds are explicit and reproducible. The behaviour (the binary carries the
// pinned modules; the upgrade builds only on changed inputs) is proven by the live suite's image
// build and upgrade.test.ts; this pins the static wiring.
describe('locally built images', () => {
  it('are the only services with a build section, never pulled from a registry', () => {
    const built = Object.entries(services).filter(([, service]) => service.build !== undefined);
    expect(built.map(([, service]) => service.image).sort()).toEqual(Object.keys(LOCAL).sort());
    for (const [name, service] of built) expect(service.pull_policy, name).toBe('never');
  });

  it('pins every Caddy module by version and verifies the build carries exactly those', () => {
    const dockerfile = read('caddy/Dockerfile');
    const modules = [...dockerfile.matchAll(/^ARG (CADDY_[A-Z_]+_MODULE)=(\S+)$/gm)];
    expect(modules.map((m) => m[1])).toEqual(['CADDY_DNS_MODULE', 'CADDY_RATELIMIT_MODULE']);
    for (const [, , module] of modules) expect(module).toMatch(/^[\w./-]+@v\d+\.\d+\.\d+$/);
    // Modules come from the public proxy, checked against the Go checksum database, with no
    // toolchain download; the build refuses an unpinned module and checks the binary's modules.
    expect(dockerfile).toContain('GOPROXY=https://proxy.golang.org');
    expect(dockerfile).toContain('GOSUMDB=sum.golang.org');
    expect(dockerfile).toContain('GOTOOLCHAIN=local');
    expect(dockerfile).toContain('must be pinned as <path>@<version>');
    expect(dockerfile).toContain('go version -m /usr/bin/caddy');
    // Compose's default for the DNS module is the Dockerfile's, so both builds agree.
    const caddyBuild = services.caddy?.build as { args: Record<string, string> };
    const dnsDefault = modules.find((m) => m[1] === 'CADDY_DNS_MODULE')?.[2];
    expect(caddyBuild.args.CADDY_DNS_MODULE).toBe(`\${CADDY_DNS_MODULE:-${dnsDefault}}`);
  });

  it('sends Caddy an empty build context, so Caddyfile edits never change the image', () => {
    const ignore = read('caddy/.dockerignore')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'));
    expect(ignore).toEqual(['*']);
    expect(read('caddy/Dockerfile')).not.toMatch(/^(COPY|ADD)\s+(?!--from=)/m);
  });

  it.each(['sam-mx', 'sam-dns'])('builds %s from go.sum-pinned modules', (dir) => {
    const dockerfile = read(`${dir}/Dockerfile`);
    expect(dockerfile).toMatch(/^COPY go\.mod go\.sum \.\/$/m);
    expect(read(`${dir}/go.sum`).trim().length).toBeGreaterThan(0);
  });
});
