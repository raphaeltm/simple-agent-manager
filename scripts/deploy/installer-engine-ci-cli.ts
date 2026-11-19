#!/usr/bin/env -S pnpm exec tsx
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  type EngineCheckpoint,
  parseEngineCheckpoint,
  runInstallerEngine,
  writeEngineCheckpoint,
} from './installer-engine.js';
import {
  type LegacyCiInput,
  legacyCiInvocation,
  parseLegacyCiInput,
} from './installer-engine-ci.js';

function writeDeploymentSummary(input: LegacyCiInput, domain: string, success: boolean): void {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Deployment ${input.dryRun ? 'preview' : input.environment}: ${success ? 'complete' : 'failed'}\n\nCommit: ${input.sourceCommit}\n\n${input.dryRun ? 'Pulumi preview only.' : `API: https://api.${domain}\n\nApp: https://app.${domain}`}\n\n${success && !input.dryRun ? `Deployed infrastructure, D1 migration checks, API/Tail Workers, Pages UI, Codex runtime and CLI artifacts${input.skipAgent ? '' : ', and VM-agent binaries'}.` : ''}\n\nSecurity keys: ${input.secrets.ENCRYPTION_KEY ? 'explicit legacy override' : 'persisted Pulumi state'}.\n`
    );
}

let startupStage = 'arguments';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [inputPath, statePath] = args;
  if (!inputPath || !statePath)
    throw new Error(
      'Usage: installer-engine-ci-cli.ts <non-secret-input-json> <private-state-json>'
    );
  startupStage = 'public-input-json';
  const parsed: unknown = JSON.parse(readFileSync(inputPath, 'utf8'));
  startupStage = 'private-input-json';
  const privateInput: unknown = JSON.parse(process.env.SAM_CI_SECRETS_JSON ?? '');
  startupStage = 'input-validation';
  const input = parseLegacyCiInput(parsed, privateInput);
  const secrets = input.secrets;
  startupStage = 'environment-adapter';
  const invocation = legacyCiInvocation(process.cwd(), { ...input, secrets });
  startupStage = 'checkpoint';
  let checkpoint: EngineCheckpoint | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    checkpoint = parseEngineCheckpoint(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Invalid CI checkpoint');
  }
  // Do not pass the whole GitHub secret JSON to arbitrary build subprocesses.
  const environment = { ...process.env, ...invocation.environment };
  delete environment.SAM_CI_SECRETS_JSON;
  let success = false;
  try {
    startupStage = 'engine';
    await runInstallerEngine(invocation.config, {
      root: process.cwd(),
      environment,
      checkpoint,
      save: (state) => writeEngineCheckpoint(statePath, state),
      reportArtifact: (artifact) => {
        if (process.env.GITHUB_STEP_SUMMARY)
          appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `### CF Container runtime artifact\n\nVersion: ${artifact.version}\n\nBuild date: ${artifact.buildDate}\n\nSHA-256: ${artifact.sha256}\n`
          );
      },
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    });
    success = true;
    if (process.env.GITHUB_OUTPUT && !input.dryRun)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `api_url=https://api.${invocation.config.baseDomain}\napp_url=https://app.${invocation.config.baseDomain}\n`
      );
  } finally {
    writeDeploymentSummary(input, invocation.config.baseDomain, success);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ status: 'failed', stage: startupStage, code: 'CI_DEPLOYMENT_STOPPED' })}\n`
    );
    process.exitCode = 1;
  });
