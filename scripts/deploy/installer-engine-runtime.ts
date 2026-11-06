import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error Shared source-build identity helper is JavaScript without declarations.
import * as runtimeIdentity from './installer-runtime-identity.mjs';

interface RuntimeAssociation {
  schemaVersion: 1;
  baseRelease: string;
  release: string;
  buildDate: string;
  runtimeInputsSHA256: string;
  archiveSHA256: string;
  archiveBytes: number;
  catalogSHA256: string;
  installerSHA256: string;
  sourceCommit: string;
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Validate the source hook's receipt against approved Git inputs and actual
 * trusted bytes before any Wrangler config advertises this agent release. */
export function verifyInstallationAgentIdentity(
  root: string,
  sourceCommit: string,
  baseRelease: string,
  buildDate: string,
  inputs: string
): RuntimeAssociation {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, '.wrangler/installer-runtime-agent-identity.json'), 'utf8')
  );
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Installation runtime identity missing');
  const receipt = parsed as RuntimeAssociation;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sourceCommit !== sourceCommit ||
    receipt.baseRelease !== baseRelease ||
    receipt.buildDate !== buildDate ||
    receipt.runtimeInputsSHA256 !== inputs ||
    !/^[a-f0-9]{64}$/.test(inputs) ||
    !/^[a-f0-9]{40}$/.test(receipt.release) ||
    ['archiveSHA256', 'catalogSHA256', 'installerSHA256'].some(
      (key) => !/^[a-f0-9]{64}$/.test(String(receipt[key as keyof RuntimeAssociation]))
    )
  )
    throw new Error('Installation runtime identity does not match approved source');
  const archive = readFileSync(
    join(root, 'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz')
  );
  const installer = readFileSync(
    join(root, 'apps/api/container-artifacts/install-codex-runtime.sh')
  );
  if (
    receipt.archiveSHA256 !== sha256(archive) ||
    receipt.archiveBytes !== archive.length ||
    receipt.installerSHA256 !== sha256(installer) ||
    receipt.installerSHA256 !==
      sha256(readFileSync(join(root, 'packages/vm-agent/internal/acp/codex_runtime_installer.sh')))
  )
    throw new Error('Installation runtime bytes changed after verification');
  for (const [file, anchor] of [
    ['packages/vm-agent/internal/acp/codex_runtime_distribution.go', receipt.archiveSHA256],
    ['packages/vm-agent/internal/acp/codex_staging_candidate.go', receipt.catalogSHA256],
    ['apps/api/src/routes/codex-runtime.ts', receipt.archiveSHA256],
  ]) {
    if (!file || !anchor || !readFileSync(join(root, file), 'utf8').includes(anchor))
      throw new Error('Compiled runtime trust anchor missing');
  }
  const derived = runtimeIdentity.runtimeAgentAssociation(
    baseRelease,
    buildDate,
    receipt,
    inputs
  ) as { release: string };
  if (derived.release !== receipt.release)
    throw new Error('Installation agent identity digest mismatch');
  return receipt;
}
