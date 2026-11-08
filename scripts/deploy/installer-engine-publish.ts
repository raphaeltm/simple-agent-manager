import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import * as TOML from '@iarna/toml';

import { VM_AGENT_OUTPUTS } from './installer-engine-cache.js';
import {
  fetchPrebuiltManifest,
  imageContextKey,
  PREBUILT_MANIFEST,
  type PrebuiltManifest,
  vmAgentPrebuiltKey,
} from './installer-engine-prebuilt.js';

/**
 * Publisher side of the optional prebuilt artifacts (installer-engine-prebuilt.ts).
 * SAM's release workflow builds the VM agent and the API container images exactly
 * as an installation would, then calls this to stage every file plus
 * `sam-installer-artifacts.json` in one flat directory for release upload.
 */

export interface PublishedImage {
  className: string;
  /** Tarred OCI image layout. */
  archive: string;
  /** Manifest digest of the image as pushed (`crane digest`). */
  digest: string;
}

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Flat release-asset name for a repository-relative path. */
export const assetName = (path: string) => path.toLowerCase().replaceAll('/', '--');

export function containerDockerfiles(root: string): Map<string, string> {
  const topLevel = TOML.parse(
    readFileSync(join(root, 'apps/api/wrangler.toml'), 'utf8')
  ) as unknown as {
    containers?: { class_name: string; image: string }[];
  };
  return new Map(
    (topLevel.containers ?? []).map((c) => [c.class_name, c.image.replace(/^\.\//, '')])
  );
}

export async function stagePrebuiltArtifacts(input: {
  root: string;
  out: string;
  release: string;
  buildDate: string;
  goVersion: string;
  images: readonly PublishedImage[];
}): Promise<PrebuiltManifest> {
  mkdirSync(input.out, { recursive: true });
  const key = vmAgentPrebuiltKey(input.release, input.buildDate, input.goVersion);
  const files = VM_AGENT_OUTPUTS.map((path) => {
    const source = join(input.root, path);
    const name = assetName(path);
    copyFileSync(source, join(input.out, name));
    return {
      kind: 'vm-agent',
      key,
      path,
      name,
      sha256: sha256File(source),
      size: statSync(source).size,
    };
  });
  const dockerfiles = containerDockerfiles(input.root);
  const images = input.images.map((image) => {
    const dockerfile = dockerfiles.get(image.className);
    if (!dockerfile) throw new Error(`No container class ${image.className} in wrangler.toml`);
    const name = `image-${image.className.toLowerCase()}.tar`;
    copyFileSync(image.archive, join(input.out, name));
    return {
      className: image.className,
      key: imageContextKey(join(input.root, 'apps/api'), dockerfile),
      name,
      sha256: sha256File(image.archive),
      size: statSync(image.archive).size,
      digest: image.digest,
    };
  });
  const manifest: PrebuiltManifest = { schemaVersion: 1, files, images };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  // Publish only what the consumer would accept.
  const accepted = await fetchPrebuiltManifest(
    async () => new Response(text),
    'https://publisher.invalid'
  );
  if (
    !accepted ||
    accepted.files.length !== files.length ||
    accepted.images.length !== images.length
  )
    throw new Error('Generated manifest would be rejected by installations');
  writeFileSync(join(input.out, PREBUILT_MANIFEST), text);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      release: { type: 'string' },
      'build-date': { type: 'string' },
      'go-version': { type: 'string' },
      // className=archive=digest
      image: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.out || !values.release || !values['build-date'] || !values['go-version'])
    throw new Error('--out, --release, --build-date and --go-version are required');
  const images = (values.image ?? []).map((spec) => {
    const [className, archive, digest] = spec.split('=');
    if (!className || !archive || !/^sha256:[a-f0-9]{64}$/.test(digest ?? ''))
      throw new Error(`Invalid --image ${spec}`);
    return { className, archive, digest };
  });
  const manifest = await stagePrebuiltArtifacts({
    root: process.cwd(),
    out: values.out,
    release: values.release,
    buildDate: values['build-date'],
    goVersion: values['go-version'],
    images,
  });
  console.log(
    `Staged ${manifest.files.length} files and ${manifest.images.length} images in ${values.out}`
  );
}
