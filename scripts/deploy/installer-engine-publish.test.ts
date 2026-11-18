import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VM_AGENT_OUTPUTS } from './installer-engine-cache.js';
import {
  fetchPrebuiltManifest,
  imageContextKey,
  placePrebuiltFiles,
  PREBUILT_MANIFEST,
  vmAgentPrebuiltKey,
} from './installer-engine-prebuilt.js';
import { assetName, stagePrebuiltArtifacts } from './installer-engine-publish.js';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  directories.push(dir);
  return dir;
};
const write = (root: string, path: string, data: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
};
const RELEASE = 'a'.repeat(40);
const DATE = '2026-11-07T21:52:36Z';
const GO = 'go version go1.26.11 linux/amd64';
const DIGEST = `sha256:${'d'.repeat(64)}`;

/** A repository with the agent outputs built and one container class. */
function builtRepository() {
  const root = temp();
  for (const path of VM_AGENT_OUTPUTS) write(root, path, `bytes of ${path}`);
  write(
    root,
    'apps/api/wrangler.toml',
    'name = "api"\n[[containers]]\nclass_name = "SandboxDO"\nimage = "./Dockerfile.sandbox"\n'
  );
  write(root, 'apps/api/Dockerfile.sandbox', 'FROM scratch\nCOPY scripts/a.mjs /a.mjs\n');
  write(root, 'apps/api/scripts/a.mjs', 'console.log(1)');
  const archive = join(temp(), 'layout.tar');
  writeFileSync(archive, 'oci layout tar');
  return { root, archive };
}

describe('prebuilt artifact publisher', () => {
  it('publishes a manifest an installation accepts and places byte-identical agent outputs', async () => {
    const { root, archive } = builtRepository();
    const out = temp();
    await stagePrebuiltArtifacts({
      root,
      out,
      release: RELEASE,
      buildDate: DATE,
      goVersion: GO,
      images: [{ className: 'SandboxDO', archive, digest: DIGEST }],
    });

    // Serve the staged directory the way a release does: flat names under a base URL.
    const base = 'https://github.com/o/r/releases/latest/download';
    const request = async (url: string) => {
      const name = url.slice(base.length + 1);
      return readdirSync(out).includes(name)
        ? new Response(readFileSync(join(out, name)))
        : new Response('missing', { status: 404 });
    };
    const manifest = await fetchPrebuiltManifest(request, base);
    expect(manifest?.files).toHaveLength(VM_AGENT_OUTPUTS.length);

    const installation = temp();
    const placed = await placePrebuiltFiles({
      request,
      base,
      manifest: manifest!,
      kind: 'vm-agent',
      // The installation derives its key with the same helper from its own identity.
      key: vmAgentPrebuiltKey(RELEASE, DATE, GO),
      root: installation,
      paths: VM_AGENT_OUTPUTS,
      timeoutMs: 5_000,
    });
    expect(placed).toBe(true);
    for (const path of VM_AGENT_OUTPUTS)
      expect(readFileSync(join(installation, path), 'utf8')).toBe(`bytes of ${path}`);

    // The image entry carries the key an installation computes from the same context.
    expect(manifest?.images).toEqual([
      expect.objectContaining({
        className: 'SandboxDO',
        key: imageContextKey(join(root, 'apps/api'), 'Dockerfile.sandbox'),
        name: 'image-sandboxdo.tar',
        digest: DIGEST,
      }),
    ]);
  });

  it('does not match an installation built with a different Go toolchain', async () => {
    const { root } = builtRepository();
    const out = temp();
    await stagePrebuiltArtifacts({
      root,
      out,
      release: RELEASE,
      buildDate: DATE,
      goVersion: GO,
      images: [],
    });
    const manifest = JSON.parse(readFileSync(join(out, PREBUILT_MANIFEST), 'utf8'));
    const placed = await placePrebuiltFiles({
      request: async (url) => new Response(readFileSync(join(out, url.split('/').pop()!))),
      base: 'https://example.com',
      manifest,
      kind: 'vm-agent',
      key: vmAgentPrebuiltKey(RELEASE, DATE, 'go version go1.26.10 linux/amd64'),
      root: temp(),
      paths: VM_AGENT_OUTPUTS,
      timeoutMs: 5_000,
    });
    expect(placed).toBe(false);
  });

  it('uses flat lowercase asset names that are unique per output', () => {
    const names = VM_AGENT_OUTPUTS.map(assetName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
  });

  it('refuses an image for a container class the API does not declare', async () => {
    const { root, archive } = builtRepository();
    await expect(
      stagePrebuiltArtifacts({
        root,
        out: temp(),
        release: RELEASE,
        buildDate: DATE,
        goVersion: GO,
        images: [{ className: 'Unknown', archive, digest: DIGEST }],
      })
    ).rejects.toThrow('No container class Unknown');
  });

  it('refuses to publish a manifest installations would reject', async () => {
    const { root, archive } = builtRepository();
    await expect(
      stagePrebuiltArtifacts({
        root,
        out: temp(),
        release: RELEASE,
        buildDate: DATE,
        goVersion: GO,
        images: [{ className: 'SandboxDO', archive, digest: 'sha256:short' }],
      })
    ).rejects.toThrow('would be rejected');
  });
});
