import { createHash } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Optional prebuilt artifacts for an installation. A publisher (SAM's release
 * workflow, or any HTTPS host an operator points at) serves
 * `<base>/sam-installer-artifacts.json` plus every file it names. Each entry is
 * keyed by the content it replaces, never by commit, so an installation reuses it
 * whenever that content is unchanged. Bytes are accepted only when their size and
 * SHA-256 match the manifest; anything missing, malformed or mismatched means the
 * installation builds that piece itself, exactly as without a manifest.
 */
export const PREBUILT_MANIFEST = 'sam-installer-artifacts.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRIES = 64;
/** Container images published so far are under 1.3 GB; 4 GiB bounds a runaway download. */
const MAX_ARTIFACT_BYTES = 4 * 1024 ** 3;
const HEX64 = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export interface PrebuiltFile {
  /** Build step this file belongs to (`vm-agent`). */
  kind: string;
  /** Content key of the inputs, compared with the installation's own key. */
  key: string;
  /** Repository-relative destination. */
  path: string;
  /** File name under the base URL. */
  name: string;
  sha256: string;
  size: number;
}
export interface PrebuiltImage {
  /** Durable Object container class the image serves (`SandboxDO`). */
  className: string;
  /** `imageContextKey` of the Dockerfile and every file it copies. */
  key: string;
  /** OCI image layout, tarred, under the base URL. */
  name: string;
  sha256: string;
  size: number;
  /** Manifest digest the pushed image must have in the account registry. */
  digest: string;
}
export interface PrebuiltManifest {
  schemaVersion: 1;
  files: PrebuiltFile[];
  images: PrebuiltImage[];
}

type Request = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Content key of the VM-agent build outputs. The release and build date come from
 * the content-derived agent release, so the key changes only with the agent's
 * sources or the Go toolchain (`go version` output).
 */
export const vmAgentPrebuiltKey = (release: string, buildDate: string, goVersion: string) =>
  `release=${release};build=${buildDate};${goVersion}`;

/** An https base URL without credentials, query or fragment, or undefined. */
export function prebuiltBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function validFile(value: unknown): value is PrebuiltFile {
  const v = value as PrebuiltFile;
  return (
    !!v &&
    KIND.test(v.kind) &&
    typeof v.key === 'string' &&
    v.key.length > 0 &&
    v.key.length <= 256 &&
    PATH.test(v.path) &&
    !v.path.split('/').includes('..') &&
    NAME.test(v.name) &&
    HEX64.test(v.sha256) &&
    Number.isSafeInteger(v.size) &&
    v.size > 0 &&
    v.size <= MAX_ARTIFACT_BYTES
  );
}

function validImage(value: unknown): value is PrebuiltImage {
  const v = value as PrebuiltImage;
  return (
    !!v &&
    CLASS.test(v.className) &&
    HEX64.test(v.key) &&
    NAME.test(v.name) &&
    HEX64.test(v.sha256) &&
    /^sha256:[a-f0-9]{64}$/.test(v.digest) &&
    Number.isSafeInteger(v.size) &&
    v.size > 0 &&
    v.size <= MAX_ARTIFACT_BYTES
  );
}

/** The publisher's manifest, or undefined when there is none or it is malformed. */
export async function fetchPrebuiltManifest(
  request: Request,
  base: string
): Promise<PrebuiltManifest | undefined> {
  try {
    const response = await request(`${base}/${PREBUILT_MANIFEST}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) return undefined;
    const parsed: unknown = JSON.parse(text);
    const value = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<PrebuiltManifest>;
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.files) ||
      !Array.isArray(value.images) ||
      value.files.length + value.images.length > MAX_ENTRIES ||
      !value.files.every(validFile) ||
      !value.images.every(validImage)
    )
      return undefined;
    return { schemaVersion: 1, files: value.files, images: value.images };
  } catch {
    return undefined;
  }
}

/**
 * Stream `url` to `destination`, accepting it only with the expected size and
 * SHA-256. The file appears at `destination` only once verified.
 */
export async function downloadVerified(
  request: Request,
  url: string,
  destination: string,
  expected: { sha256: string; size: number },
  timeoutMs: number
): Promise<boolean> {
  const partial = `${destination}.partial`;
  mkdirSync(dirname(destination), { recursive: true });
  try {
    const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) return false;
    const hash = createHash('sha256');
    const out = createWriteStream(partial, { mode: 0o600 });
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > expected.size) return false;
        hash.update(value);
        if (!out.write(value))
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve()))
      );
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) return false;
    renameSync(partial, destination);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * Place every prebuilt file of `kind` published for `key`. True only when the
 * manifest covers exactly `paths` and each verified; otherwise nothing is
 * claimed and the caller builds.
 */
export async function placePrebuiltFiles(input: {
  request: Request;
  base: string;
  manifest: PrebuiltManifest;
  kind: string;
  key: string;
  root: string;
  paths: readonly string[];
  timeoutMs: number;
}): Promise<boolean> {
  const entries = input.manifest.files.filter(
    (file) => file.kind === input.kind && file.key === input.key
  );
  const covered = new Map(entries.map((file) => [file.path, file]));
  if (covered.size !== input.paths.length || !input.paths.every((path) => covered.has(path)))
    return false;
  const results = await Promise.all(
    input.paths.map((path) => {
      const file = covered.get(path);
      if (!file) return false;
      return downloadVerified(
        input.request,
        `${input.base}/${file.name}`,
        join(input.root, path),
        file,
        input.timeoutMs
      );
    })
  );
  return results.every(Boolean);
}

/** Context sources a Dockerfile copies from the build context (`COPY --from` excluded). */
export function dockerfileSources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split('\n')) {
    const match = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const words = match[1].trim().split(/\s+/);
    if (words.some((word) => word.startsWith('--from'))) continue;
    const paths = words.filter((word) => !word.startsWith('--'));
    sources.push(...paths.slice(0, -1));
  }
  return [...new Set(sources)].sort();
}

/**
 * Content key of a container image's inputs: the Dockerfile (which pins its base
 * images by digest) and every context file it copies. Equal keys mean the same
 * build inputs, so a published image for the key can stand in for building it.
 */
export function imageContextKey(contextDir: string, dockerfilePath: string): string {
  const dockerfile = readFileSync(join(contextDir, dockerfilePath), 'utf8');
  const hash = createHash('sha256').update('sam-installer-image-v1\n');
  hash.update(`${dockerfilePath}\n${createHash('sha256').update(dockerfile).digest('hex')}\n`);
  for (const source of dockerfileSources(dockerfile)) {
    if (!PATH.test(source) || source.split('/').includes('..'))
      throw new Error('Unsupported Dockerfile source');
    const bytes = readFileSync(join(contextDir, source));
    hash.update(`${source}\n${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

/** A digest-pinned reference in the account's Cloudflare managed registry. */
export const ACCOUNT_IMAGE_REFERENCE =
  /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9][a-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/;

export interface ContainerImageSource {
  className: string;
  /** Dockerfile path relative to the API build context. */
  dockerfile: string;
}

/**
 * Push every published image whose inputs match this installation into the
 * account's managed registry and return digest-pinned references by container
 * class. Durable Object containers may only use such references, so this is a
 * copy rather than a pull at runtime. Each image is accepted only when the
 * registry reports the published manifest digest; classes without a usable
 * image are omitted and Wrangler builds them as before.
 */
export async function importPrebuiltImages(input: {
  request: Request;
  base: string;
  manifest: PrebuiltManifest;
  accountId: string;
  contextDir: string;
  containers: readonly ContainerImageSource[];
  /** Registry repository for a class, e.g. `s123abc-api-prod-sandboxdo`. */
  repository(className: string): string;
  work: string;
  timeoutMs: number;
  /** Runs a command with extra environment, returning stdout. */
  run(executable: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string>;
  /** Short-lived push/pull password for registry.cloudflare.com. */
  registryPassword(): Promise<string>;
}): Promise<Record<string, string>> {
  const wanted = input.containers.flatMap((container) => {
    const key = imageContextKey(input.contextDir, container.dockerfile);
    const image = input.manifest.images.find(
      (candidate) => candidate.className === container.className && candidate.key === key
    );
    return image ? [{ container, image }] : [];
  });
  if (!wanted.length) return {};
  rmSync(input.work, { recursive: true, force: true });
  mkdirSync(input.work, { recursive: true, mode: 0o700 });
  // Registry credentials stay in a private config file, never in process arguments.
  const config = join(input.work, 'docker-config');
  mkdirSync(config, { mode: 0o700 });
  const password = await input.registryPassword();
  const auth = Buffer.from(`v1:${password}`).toString('base64');
  writeFileSync(
    join(config, 'config.json'),
    JSON.stringify({ auths: { 'registry.cloudflare.com': { auth } } }),
    { mode: 0o600 }
  );
  const env = { DOCKER_CONFIG: config };
  const references: Record<string, string> = {};
  try {
    await Promise.all(
      wanted.map(async ({ container, image }) => {
        const archive = join(input.work, `${image.name}`);
        const layout = join(input.work, `${container.className}-layout`);
        if (
          !(await downloadVerified(
            input.request,
            `${input.base}/${image.name}`,
            archive,
            image,
            input.timeoutMs
          ))
        )
          return;
        mkdirSync(layout, { mode: 0o700 });
        await input.run('tar', ['-xf', archive, '-C', layout]);
        rmSync(archive, { force: true });
        const repository = `registry.cloudflare.com/${input.accountId}/${input.repository(container.className)}`;
        await input.run('crane', ['push', layout, `${repository}:${image.key.slice(0, 16)}`], env);
        const digest = (
          await input.run('crane', ['digest', `${repository}:${image.key.slice(0, 16)}`], env)
        ).trim();
        const reference = `${repository}@${digest}`;
        if (digest === image.digest && ACCOUNT_IMAGE_REFERENCE.test(reference))
          references[container.className] = reference;
      })
    );
  } finally {
    rmSync(input.work, { recursive: true, force: true });
  }
  return references;
}
