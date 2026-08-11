import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const VM_AGENT_REQUIRED_VERSION_BINDING = 'VM_AGENT_REQUIRED_VERSION';
export const VM_AGENT_BUILD_FINGERPRINT_BINDING = 'VM_AGENT_BUILD_FINGERPRINT';
export const VM_AGENT_COMPATIBILITY_MARKER_PATH =
  'scripts/deploy/vm-agent-compatibility-version.txt';
export const LEGACY_VM_AGENT_COMPATIBILITY_VERSION = '1';

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const VM_AGENT_SOURCE_PATH = 'packages/vm-agent';
const FINGERPRINT_SCHEMA_VERSION = 1;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type VmAgentReleaseReason =
  | 'first-deploy'
  | 'inputs-changed'
  | 'inputs-unchanged'
  | 'legacy-fingerprint-match'
  | 'legacy-fingerprint-unproven';

export interface DeployedVmAgentRelease {
  requiredVersion: string | null;
  fingerprint: string | null;
}

export interface VmAgentReleaseResolution {
  buildAgent: boolean;
  requiredVersion: string;
  fingerprint: string;
  reason: VmAgentReleaseReason;
}

export interface VmAgentBuildInputReader {
  listTrackedInputs(ref: string): string;
  readCompatibilityVersion(ref: string): string | null;
}

function normalizeGitSha(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && GIT_SHA_PATTERN.test(normalized) ? normalized : null;
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && FINGERPRINT_PATTERN.test(normalized) ? normalized : null;
}

function requireGitCommitSha(ref: string): string {
  const commitSha = normalizeGitSha(ref);
  if (!commitSha) {
    throw new Error('VM-agent build inputs must be read from a valid 40-character commit SHA');
  }
  return commitSha;
}

export function createGitBuildInputReader(repositoryRoot: string): VmAgentBuildInputReader {
  return {
    listTrackedInputs(ref) {
      const commitSha = requireGitCommitSha(ref);
      return execFileSync(
        'git',
        ['ls-tree', '-r', '-z', '--end-of-options', commitSha, '--', VM_AGENT_SOURCE_PATH],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    },
    readCompatibilityVersion(ref) {
      const commitSha = requireGitCommitSha(ref);
      try {
        return execFileSync(
          'git',
          ['show', '--end-of-options', `${commitSha}:${VM_AGENT_COMPATIBILITY_MARKER_PATH}`],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
      } catch {
        return null;
      }
    },
  };
}

export function computeVmAgentBuildFingerprint(
  ref: string,
  reader: VmAgentBuildInputReader,
  options: { allowLegacyMissingMarker?: boolean } = {}
): string {
  const trackedInputs = reader.listTrackedInputs(ref);
  if (!trackedInputs) {
    throw new Error(`No tracked VM-agent build inputs found at ${ref}`);
  }

  const marker = reader.readCompatibilityVersion(ref)?.trim();
  const compatibilityVersion =
    marker || (options.allowLegacyMissingMarker ? LEGACY_VM_AGENT_COMPATIBILITY_VERSION : null);
  if (!compatibilityVersion) {
    throw new Error(
      `Missing VM-agent compatibility marker at ${ref}:${VM_AGENT_COMPATIBILITY_MARKER_PATH}`
    );
  }

  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: FINGERPRINT_SCHEMA_VERSION,
        trackedInputs,
        compatibilityVersion,
      })
    )
    .digest('hex');
}

export function resolveVmAgentRelease(input: {
  targetVersion: string;
  targetFingerprint: string;
  deployed: DeployedVmAgentRelease | null;
  inferredPriorFingerprint?: string | null;
  skipAgent: boolean;
}): VmAgentReleaseResolution {
  const targetVersion = normalizeGitSha(input.targetVersion);
  const targetFingerprint = normalizeFingerprint(input.targetFingerprint);
  if (!targetVersion || !targetFingerprint) {
    throw new Error('Target VM-agent version and fingerprint must be valid lowercase hashes');
  }

  const priorVersion = normalizeGitSha(input.deployed?.requiredVersion);
  const recordedFingerprint = normalizeFingerprint(input.deployed?.fingerprint);
  const inferredFingerprint = normalizeFingerprint(input.inferredPriorFingerprint);
  const priorFingerprint = recordedFingerprint ?? inferredFingerprint;

  if (!priorVersion) {
    if (input.skipAgent) {
      throw new Error('skip_agent cannot be used before a published VM-agent release is available');
    }
    return {
      buildAgent: true,
      requiredVersion: targetVersion,
      fingerprint: targetFingerprint,
      reason: 'first-deploy',
    };
  }

  if (priorFingerprint === targetFingerprint) {
    return {
      buildAgent: false,
      requiredVersion: priorVersion,
      fingerprint: targetFingerprint,
      reason: recordedFingerprint ? 'inputs-unchanged' : 'legacy-fingerprint-match',
    };
  }

  if (input.skipAgent) {
    throw new Error(
      'skip_agent cannot bypass changed or unproven VM-agent build inputs; publish the agent release'
    );
  }

  return {
    buildAgent: true,
    requiredVersion: targetVersion,
    fingerprint: targetFingerprint,
    reason: priorFingerprint ? 'inputs-changed' : 'legacy-fingerprint-unproven',
  };
}

function readPlainTextBinding(bindings: unknown[], name: string): string | null {
  const matches = bindings.filter(
    (binding): binding is Record<string, unknown> =>
      typeof binding === 'object' &&
      binding !== null &&
      !Array.isArray(binding) &&
      'name' in binding &&
      binding.name === name
  );
  if (matches.length > 1) {
    throw new Error(`Cloudflare returned duplicate ${name} bindings`);
  }
  const binding = matches[0];
  if (!binding || binding.type !== 'plain_text' || typeof binding.text !== 'string') {
    return null;
  }
  return binding.text;
}

export async function getDeployedVmAgentRelease(input: {
  accountId: string;
  workerName: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}): Promise<DeployedVmAgentRelease | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url =
    `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(input.accountId)}` +
    `/workers/scripts/${encodeURIComponent(input.workerName)}/settings`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${input.apiToken}` },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to read deployed VM-agent release metadata for Worker "${input.workerName}" (HTTP ${response.status})`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Cloudflare returned invalid JSON for Worker release metadata');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('success' in payload) ||
    payload.success !== true ||
    !('result' in payload) ||
    typeof payload.result !== 'object' ||
    payload.result === null ||
    !('bindings' in payload.result) ||
    !Array.isArray(payload.result.bindings)
  ) {
    throw new Error('Cloudflare returned an invalid Worker settings response');
  }

  // SECURITY: the response also contains all other plaintext Worker bindings.
  // Return only the two allowlisted release fields and never log the payload.
  return {
    requiredVersion: readPlainTextBinding(
      payload.result.bindings,
      VM_AGENT_REQUIRED_VERSION_BINDING
    ),
    fingerprint: readPlainTextBinding(payload.result.bindings, VM_AGENT_BUILD_FINGERPRINT_BINDING),
  };
}

export function isValidVmAgentReleaseVersion(value: string | null | undefined): boolean {
  return normalizeGitSha(value) !== null;
}
