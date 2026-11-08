import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EngineArtifact } from './installer-engine-contract.js';

/** Receipt for the Codex runtime an installation staged. `source: 'publisher'`
 * records that the bytes are SAM's reviewed release archive, not an in-account build. */
export interface RuntimeTrust {
  version: 2;
  source: 'publisher';
  archiveSHA256: string;
  archiveBytes: number;
  installerSHA256: string;
}
export const RUNTIME_TRUST_PATH = '.wrangler/installer-runtime-trust.json';
const ARCHIVE = 'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz';
const STAGED_INSTALLER = 'apps/api/container-artifacts/install-codex-runtime.sh';
const REVIEWED_INSTALLER = 'packages/vm-agent/internal/acp/codex_runtime_installer.sh';
/** Every consumer that pins the archive. The VM agent and its embedded installer
 * verify the bytes on the node, the API serves only this release, and the two
 * deploy scripts stage and publish it. One disagreement fails the install. */
const PINS: Array<[path: string, digest: RegExp, bytes: RegExp]> = [
  [
    'packages/vm-agent/internal/acp/codex_runtime_distribution.go',
    /codexRuntimeArchiveSHA = "([a-f0-9]{64})"/,
    /codexRuntimeArchiveBytes = (\d+)/,
  ],
  [REVIEWED_INSTALLER, /^archive_hash='([a-f0-9]{64})'$/m, /^archive_size=(\d+)$/m],
  [
    'apps/api/src/routes/codex-runtime.ts',
    /CODEX_RUNTIME_RELEASE =\s*'([a-f0-9]{64})'/,
    /CODEX_RUNTIME_ARCHIVE_BYTES = (\d+);/,
  ],
  [
    'scripts/deploy/prepare-codex-runtime-artifact.sh',
    /^release='([a-f0-9]{64})'$/m,
    /^size=(\d+)$/m,
  ],
  [
    'scripts/deploy/publish-codex-runtime-artifact.sh',
    /^release='([a-f0-9]{64})'$/m,
    /^size=(\d+)$/m,
  ],
];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The single archive digest and size pinned across the approved source. */
export function sourceRuntimePins(root: string): { archiveSHA256: string; archiveBytes: number } {
  const found = PINS.map(([path, digest, bytes]) => {
    const source = readFileSync(join(root, path), 'utf8');
    const archiveSHA256 = digest.exec(source)?.[1];
    const archiveBytes = Number(bytes.exec(source)?.[1]);
    if (!archiveSHA256 || !Number.isSafeInteger(archiveBytes) || archiveBytes <= 0)
      throw new Error('Codex runtime pin missing from approved source');
    return { archiveSHA256, archiveBytes };
  });
  const [first] = found;
  if (
    !first ||
    found.some(
      (pin) => pin.archiveSHA256 !== first.archiveSHA256 || pin.archiveBytes !== first.archiveBytes
    )
  )
    throw new Error('Codex runtime pins disagree across approved source');
  return first;
}

/** Derive the trust receipt from the staged bytes, not from the staging script's
 * word. The VM-agent release identity (resolve-vm-agent-release.sh) covers the Go
 * and installer pins, so equality here keeps VM_AGENT_RELEASE describing exactly
 * the runtime that ships. */
export function verifyPublisherRuntime(root: string): RuntimeTrust {
  const pins = sourceRuntimePins(root);
  const archive = readFileSync(join(root, ARCHIVE));
  const installer = readFileSync(join(root, STAGED_INSTALLER));
  if (sha256(archive) !== pins.archiveSHA256 || archive.length !== pins.archiveBytes)
    throw new Error('Staged Codex runtime does not match approved source pins');
  if (!installer.equals(readFileSync(join(root, REVIEWED_INSTALLER))))
    throw new Error('Staged Codex installer is not the reviewed installer');
  const trust: RuntimeTrust = {
    version: 2,
    source: 'publisher',
    ...pins,
    installerSHA256: sha256(installer),
  };
  writeFileSync(join(root, RUNTIME_TRUST_PATH), JSON.stringify(trust), { mode: 0o600 });
  return trust;
}

/** The container VM-agent identity the build produced, whether compiled or restored. */
export function readContainerArtifact(
  root: string,
  release: string,
  buildDate: string
): EngineArtifact {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'apps/api/container-artifacts/vm-agent-version.json'), 'utf8')
  );
  const artifact = parsed as { version?: unknown; buildDate?: unknown; sha256?: unknown };
  if (
    !artifact ||
    artifact.version !== release ||
    artifact.buildDate !== buildDate ||
    typeof artifact.sha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)
  )
    throw new Error('Invalid container artifact identity');
  return { kind: 'vm-agent-container', version: release, buildDate, sha256: artifact.sha256 };
}
