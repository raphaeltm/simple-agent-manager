#!/usr/bin/env tsx

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEPLOYMENT_CONFIG } from './config.js';
import {
  computeVmAgentBuildFingerprint,
  createGitBuildInputReader,
  getDeployedVmAgentRelease,
  isValidVmAgentReleaseVersion,
  resolveVmAgentRelease,
} from './vm-agent-release.js';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to resolve the VM-agent release`);
  return value;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, '../..');
  const targetVersion = requireEnv('DEPLOY_SHA').toLowerCase();
  const stack = requireEnv('PULUMI_STACK');
  const accountId = requireEnv('CF_ACCOUNT_ID');
  const apiToken = process.env.CF_API_TOKEN?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error('CF_API_TOKEN or CLOUDFLARE_API_TOKEN is required');
  }

  const reader = createGitBuildInputReader(repositoryRoot);
  const targetFingerprint = computeVmAgentBuildFingerprint(targetVersion, reader);
  const workerName = DEPLOYMENT_CONFIG.resources.workerName(stack);
  const deployed = await getDeployedVmAgentRelease({
    accountId,
    workerName,
    apiToken,
  });

  let inferredPriorFingerprint: string | null = null;
  if (
    deployed?.requiredVersion &&
    !deployed.fingerprint &&
    isValidVmAgentReleaseVersion(deployed.requiredVersion)
  ) {
    try {
      inferredPriorFingerprint = computeVmAgentBuildFingerprint(deployed.requiredVersion, reader, {
        allowLegacyMissingMarker: true,
      });
    } catch {
      console.warn(
        'Unable to prove the legacy VM-agent fingerprint from the deployed release; a fresh release will be published.'
      );
    }
  }

  const resolution = resolveVmAgentRelease({
    targetVersion,
    targetFingerprint,
    deployed,
    inferredPriorFingerprint,
    skipAgent: process.env.SKIP_AGENT === 'true',
  });

  const githubOutput = requireEnv('GITHUB_OUTPUT');
  appendFileSync(
    githubOutput,
    [
      `build_agent=${String(resolution.buildAgent)}`,
      `required_version=${resolution.requiredVersion}`,
      `fingerprint=${resolution.fingerprint}`,
      `reason=${resolution.reason}`,
      '',
    ].join('\n')
  );

  console.log(
    JSON.stringify({
      workerName,
      buildAgent: resolution.buildAgent,
      requiredVersion: resolution.requiredVersion,
      fingerprint: resolution.fingerprint,
      reason: resolution.reason,
    })
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'VM-agent release resolution failed');
  process.exitCode = 1;
});
