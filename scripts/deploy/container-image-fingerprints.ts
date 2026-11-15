/**
 * Fingerprints of the inputs `container-image-inputs.ts` finds in a Dockerfile.
 * Each one must change whenever the upstream source could make the build produce
 * different bytes. Every failure throws; the caller treats a throw as "no key",
 * which means rebuild.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AptSource,
  aptSourceId,
  type ImageInputs,
  type InputFingerprints,
  type PypiTool,
  pypiToolId,
} from './container-image-inputs';
import { REVIEWED_NPM_INSTALL_SCRIPTS } from './container-image-reviewed-inputs';

export interface FingerprintIo {
  /** GET a URL and return its body; throws on a non-2xx status. */
  fetchBytes(url: string): Promise<Buffer>;
  /** Run a command and return stdout; throws on a non-zero exit. */
  run(command: string, args: string[], options: { cwd?: string; input?: string }): Promise<string>;
}

/** A parsed JSON object, or a throw. Runtime check at the JSON boundary. */
export function jsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    // Never echo the input: a credential response may be in it.
    throw new Error(`Unreadable ${what}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Unreadable ${what}`);
  return value as Record<string, unknown>;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Python platform the images run on (linux/amd64, glibc). */
const PYTHON_PLATFORM = 'x86_64-unknown-linux-gnu';

/**
 * Hash of a suite's package index entries for the architectures the image
 * installs from. `InRelease` lists the SHA256 of every index file, so the
 * fingerprint changes exactly when a Packages index of these components changes,
 * and not when only the signature date is refreshed.
 */
export function aptIndexFingerprint(inRelease: string, source: AptSource): string {
  const lines: string[] = [];
  let inSha256 = false;
  for (const line of inRelease.split('\n')) {
    if (/^SHA256:/.test(line)) {
      inSha256 = true;
      continue;
    }
    if (/^\S/.test(line)) inSha256 = false;
    if (!inSha256) continue;
    const [hash, size, path] = line.trim().split(/\s+/);
    if (!/^[a-f0-9]{64}$/.test(hash ?? '') || !/^\d+$/.test(size ?? '') || !path) continue;
    const match = /^([^/]+)\/binary-(amd64|all)\/Packages(?:\.(?:xz|gz|bz2))?$/.exec(path);
    if (match && source.components.includes(match[1])) lines.push(`${hash} ${path}`);
  }
  for (const component of source.components)
    if (!lines.some((line) => line.includes(` ${component}/binary-amd64/Packages`)))
      throw new Error(`No amd64 package index for ${aptSourceId(source)} component ${component}`);
  return sha256(lines.sort().join('\n'));
}

/**
 * Resolved versions and integrity of one globally installed npm package.
 * `npm install -g a b` gives each package its own tree, so each is resolved in
 * isolation; resolving them together would let one package's pins satisfy
 * another's ranges and hide an upstream release.
 */
export function npmLockFingerprint(lockJson: string, scriptsRun = false): string {
  const packages = jsonObject(lockJson, 'npm lock').packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages))
    throw new Error('Unreadable npm lock');
  const entries = Object.entries(packages as Record<string, unknown>)
    .filter(([path]) => path !== '')
    .map(([path, value]) => {
      if (!value || typeof value !== 'object') throw new Error(`npm lock entry ${path} unreadable`);
      const entry = value as Record<string, unknown>;
      if (typeof entry.version !== 'string' || !entry.version)
        throw new Error(`npm lock entry ${path} has no version`);
      const identity =
        typeof entry.integrity === 'string'
          ? entry.integrity
          : typeof entry.resolved === 'string'
            ? entry.resolved
            : '';
      if (!identity) throw new Error(`npm lock entry ${path} has no integrity`);
      const name = path.split('node_modules/').pop() ?? path;
      if (scriptsRun && entry.hasInstallScript === true && !REVIEWED_NPM_INSTALL_SCRIPTS[name])
        throw new Error(`${name} has an unreviewed install script (REVIEWED_NPM_INSTALL_SCRIPTS)`);
      return `${path}@${entry.version} ${identity}`;
    });
  if (!entries.length) throw new Error('Empty npm lock');
  return sha256(entries.sort().join('\n'));
}

async function npmFingerprint(
  spec: string,
  scriptsRun: boolean,
  io: FingerprintIo
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sam-npm-fingerprint-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"sam-image-fingerprint","private":true}');
    await io.run(
      'npm',
      [
        'install',
        spec,
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefer-online',
        // Global installs place each package's dependencies under it.
        '--install-strategy=shallow',
      ],
      { cwd: dir }
    );
    return npmLockFingerprint(readFileSync(join(dir, 'package-lock.json'), 'utf8'), scriptsRun);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pypiFingerprint(tool: PypiTool, io: FingerprintIo, uv: string): Promise<string> {
  const resolved = await io.run(
    uv,
    [
      'pip',
      'compile',
      '-',
      '--python-version',
      tool.python,
      '--python-platform',
      PYTHON_PLATFORM,
      '--no-header',
      '--no-annotate',
      '--no-cache',
      // Never build an sdist to read its metadata: that runs upstream code. An
      // sdist-only dependency then fails the fingerprint, which means rebuild.
      '--no-build',
      '--no-config',
      '--quiet',
    ],
    { input: `${[tool.spec, ...tool.with].join('\n')}\n` }
  );
  const pins = resolved
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!pins.length || !pins.every((line) => /^[A-Za-z0-9._-]+(?:\[[^\]]*\])?==\S+/.test(line)))
    throw new Error(`Unreadable uv resolution for ${tool.spec}`);
  return sha256(pins.sort().join('\n'));
}

/** `<octal mode>:<sha256>` of a copied context file. Directories and links are refused. */
export function fileFingerprint(contextDir: string, path: string): string {
  const absolute = join(contextDir, path);
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new Error(`Copied path ${path} is not a regular file`);
  return `${(stat.mode & 0o777).toString(8)}:${sha256(readFileSync(absolute))}`;
}

/** Every fingerprint the image key needs. Network lookups run concurrently. */
export async function fingerprintInputs(input: {
  contextDir: string;
  inputs: ImageInputs;
  io: FingerprintIo;
  uv: string;
}): Promise<InputFingerprints> {
  const { inputs, io } = input;
  const files = Object.fromEntries(
    inputs.copies.map((path) => [path, fileFingerprint(input.contextDir, path)])
  );
  const entries = async <T>(
    items: T[],
    id: (item: T) => string,
    run: (item: T) => Promise<string>
  ) =>
    Object.fromEntries(await Promise.all(items.map(async (item) => [id(item), await run(item)])));
  const [apt, urls, npm, pypi] = await Promise.all([
    entries(inputs.apt, aptSourceId, async (source) =>
      aptIndexFingerprint(
        (await io.fetchBytes(`${source.url}/dists/${source.suite}/InRelease`)).toString('utf8'),
        source
      )
    ),
    entries(
      inputs.urls,
      (url) => url,
      async (url) => sha256(await io.fetchBytes(url))
    ),
    entries(
      inputs.npm,
      (spec) => spec,
      (spec) => npmFingerprint(spec, inputs.npmScripts.includes(spec), io)
    ),
    entries(inputs.pypi, pypiToolId, (tool) => pypiFingerprint(tool, io, input.uv)),
  ]);
  return { files, apt, urls, npm, pypi };
}
