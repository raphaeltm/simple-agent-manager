// Compile installation-owned hashes into an isolated source checkout before build.
// This is a build-time trust decision; deployed code has no digest override switch.
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  digest,
  publisher,
  installerFor,
  validatePrevious,
} from './build-installation-codex-package.mjs';
export function materializeTrust(output, repo) {
  const trust = JSON.parse(readFileSync(join(output, 'installation-codex-trust.json'), 'utf8'));
  const hashes = [
    'archiveSHA256',
    'catalogSHA256',
    'noticesSHA256',
    'sourceSHA256',
    'reviewSHA256',
    'installerSHA256',
  ];
  if (
    trust.version !== 1 ||
    hashes.some((name) => !/^[a-f0-9]{64}$/.test(trust[name])) ||
    trust.identity !== `${publisher.identity}-installation-${trust.reviewSHA256.slice(0, 16)}` ||
    !Number.isSafeInteger(trust.archiveBytes) ||
    trust.archiveBytes <= 0 ||
    trust.archiveBytes > 300 * 1024 * 1024
  )
    throw new Error('Invalid installation trust manifest');
  for (const [file, expected] of [
    ['codex-runtime-linux-amd64.tar.gz', trust.archiveSHA256],
    ['install-codex-runtime.sh', trust.installerSHA256],
  ]) {
    const path = join(output, file);
    if (
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink() ||
      digest(readFileSync(path)) !== expected
    )
      throw new Error(`Installation artifact mismatch: ${file}`);
  }
  if (readFileSync(join(output, 'codex-runtime-linux-amd64.tar.gz')).length !== trust.archiveBytes)
    throw new Error('Archive size mismatch');
  if (
    digest(readFileSync(join(repo, 'scripts/diagnostics/pinned-codex-local.provenance'))) !==
    trust.sourceSHA256
  )
    throw new Error('Source provenance mismatch');
  if (trust.previous) validatePrevious(trust.previous);
  const substitutions = [
    [publisher.identity, trust.identity],
    [publisher.archive, trust.archiveSHA256],
    [publisher.catalog, trust.catalogSHA256],
    [publisher.notices, trust.noticesSHA256],
    [String(publisher.size), String(trust.archiveBytes)],
  ];
  const paths = [
    'packages/vm-agent/internal/acp/codex_runtime_installer.sh',
    'packages/vm-agent/internal/acp/codex_runtime_distribution.go',
    'packages/vm-agent/internal/acp/codex_staging_candidate.go',
    'apps/api/src/routes/codex-runtime.ts',
    'scripts/deploy/prepare-codex-runtime-artifact.sh',
    'scripts/deploy/publish-codex-runtime-artifact.sh',
  ];
  const updates = paths.map((path) => {
    const absolute = join(repo, path);
    const original = readFileSync(absolute, 'utf8');
    const installedAnchor = path.endsWith('codex_staging_candidate.go')
      ? trust.catalogSHA256
      : trust.archiveSHA256;
    if (original.includes(installedAnchor)) return [absolute, original];
    const present = substitutions.filter(([oldValue]) => original.includes(oldValue));
    if (!present.length) throw new Error(`Expected publisher trust anchors missing: ${path}`);
    let updated = original;
    for (const [oldValue, newValue] of present) updated = updated.replaceAll(oldValue, newValue);
    if (path.endsWith('codex_runtime_installer.sh')) updated = installerFor(trust, original);
    if (path.endsWith('codex-runtime.ts') && trust.previous) {
      updated = updated
        .replace(
          'e85e7bfee875bb0bc0397a546073b324258d4cba2c0e54cb3808c3596825b292',
          trust.previous.archiveSHA256
        )
        .replace('132578703', String(trust.previous.archiveBytes));
    }
    return [absolute, updated];
  });
  // Never execute a supplied installer: reconstruct it from this trusted checkout.
  if (digest(Buffer.from(updates[0][1])) !== trust.installerSHA256)
    throw new Error('Generated installer does not match reviewed template');
  for (const [path, contents] of updates) writeFileSync(path, contents);
  return trust;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv.length !== 4)
    throw new Error('usage: trust <artifact-dir> <isolated-source-checkout>');
  materializeTrust(...process.argv.slice(2).map((value) => resolve(value)));
}
