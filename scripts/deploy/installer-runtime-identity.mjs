// Installation-only identity. Publisher CI keeps its existing source-release path.
// Read Git objects, not the trust-materialized working tree, so a resumed build
// computes the same key. Unknown files inside input directories rotate the key.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export const runtimeInputPaths = [
  'scripts/diagnostics/build-pinned-codex-review.sh',
  'scripts/diagnostics/pinned-codex-local.provenance',
  'scripts/diagnostics/pinned-codex-bin',
  'scripts/diagnostics/patches',
  'scripts/deploy/build-installation-codex-package.mjs',
  'scripts/deploy/build-installation-codex-trust.mjs',
  'scripts/deploy/build-installation-codex-runtime.sh',
  'scripts/deploy/installer-runtime-identity.mjs',
  'scripts/deploy/installer-builder-bootstrap-source-build.sh',
  'scripts/deploy/installer-builder-bootstrap.sh',
  'packages/vm-agent/internal/acp/codex_runtime_installer.sh',
  'packages/vm-agent/internal/acp/codex_runtime_distribution.go',
  'packages/vm-agent/internal/acp/codex_staging_candidate.go',
];
export function runtimeInputIdentity(repo, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Immutable source required');
  const objects = runtimeInputPaths.map((path) => {
    const object = execFileSync('/usr/bin/git', ['rev-parse', `${commit}:${path}`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[a-f0-9]{40,64}$/.test(object)) throw new Error('Runtime input object unavailable');
    return [path, object];
  });
  return createHash('sha256')
    .update(JSON.stringify({ format: 'sam-runtime-inputs-v1', objects }))
    .digest('hex');
}
export function runtimeAgentAssociation(baseRelease, buildDate, trust, inputs) {
  if (
    !/^[a-f0-9]{40}$/.test(baseRelease) ||
    !Number.isFinite(Date.parse(buildDate)) ||
    !/^[a-f0-9]{64}$/.test(inputs) ||
    ['archiveSHA256', 'catalogSHA256', 'installerSHA256'].some(
      (key) => !/^[a-f0-9]{64}$/.test(trust[key])
    ) ||
    !Number.isSafeInteger(trust.archiveBytes) ||
    trust.archiveBytes <= 0
  )
    throw new Error('Invalid runtime/agent association');
  // Installer bytes are embedded in Go too. Including their exact digest covers
  // pinned predecessors, not just the selected executable's catalog.
  const release = createHash('sha256')
    .update(
      JSON.stringify({
        format: 'sam-installation-agent-v1',
        baseRelease,
        inputs,
        archive: trust.archiveSHA256,
        bytes: trust.archiveBytes,
        catalog: trust.catalogSHA256,
        installer: trust.installerSHA256,
      })
    )
    .digest('hex')
    .slice(0, 40);
  return {
    schemaVersion: 1,
    baseRelease,
    release,
    buildDate,
    runtimeInputsSHA256: inputs,
    archiveSHA256: trust.archiveSHA256,
    archiveBytes: trust.archiveBytes,
    catalogSHA256: trust.catalogSHA256,
    installerSHA256: trust.installerSHA256,
  };
}
export function writeRuntimeAssociation(repo, commit, artifacts, output) {
  const inputs = runtimeInputIdentity(repo, commit);
  const trust = JSON.parse(readFileSync(join(artifacts, 'installation-codex-trust.json'), 'utf8'));
  const resolved = execFileSync(
    '/usr/bin/bash',
    ['scripts/deploy/resolve-vm-agent-release.sh', commit],
    {
      cwd: repo,
      encoding: 'utf8',
    }
  );
  const base = /^release=([a-f0-9]{40})$/m.exec(resolved)?.[1];
  const date = /^build_date=(.+)$/m.exec(resolved)?.[1];
  const association = {
    ...runtimeAgentAssociation(base, date, trust, inputs),
    sourceCommit: commit,
  };
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(association), { mode: 0o600 });
  return association;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'inputs' && args.length === 2)
    process.stdout.write(runtimeInputIdentity(resolve(args[0]), args[1]));
  else if (mode === 'associate' && args.length === 4)
    writeRuntimeAssociation(resolve(args[0]), args[1], resolve(args[2]), resolve(args[3]));
  else
    throw new Error(
      'usage: identity inputs <repo> <commit> | associate <repo> <commit> <artifacts> <output.json>'
    );
}
