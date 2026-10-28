#!/usr/bin/env -S pnpm exec tsx
import { appendFileSync, readFileSync } from 'node:fs';

import {
  type EngineCheckpoint,
  parseEngineCheckpoint,
  runInstallerEngine,
  writeEngineCheckpoint,
} from './installer-engine.js';
import { legacyCiInvocation, parseLegacyCiInput } from './installer-engine-ci.js';

async function main(): Promise<void> {
  const [inputPath, statePath] = process.argv.slice(2);
  if (!inputPath || !statePath)
    throw new Error(
      'Usage: installer-engine-ci-cli.ts <non-secret-input-json> <private-state-json>'
    );
  const parsed: unknown = JSON.parse(readFileSync(inputPath, 'utf8'));
  const privateInput: unknown = JSON.parse(process.env.SAM_CI_SECRETS_JSON ?? '');
  const input = parseLegacyCiInput(parsed, privateInput);
  const secrets = input.secrets;
  const invocation = legacyCiInvocation(process.cwd(), { ...input, secrets });
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
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Deployment ${input.dryRun ? 'preview' : input.environment}: ${success ? 'complete' : 'failed'}\n\nCommit: ${input.sourceCommit}\n\n${input.dryRun ? 'Pulumi preview only.' : `API: https://api.${invocation.config.baseDomain}\n\nApp: https://app.${invocation.config.baseDomain}`}\n\n${success && !input.dryRun ? `Deployed infrastructure, D1 migration checks, API/Tail Workers, Pages UI, Codex runtime and CLI artifacts${input.skipAgent ? '' : ', and VM-agent binaries'}.` : ''}\n\nSecurity keys: ${secrets.ENCRYPTION_KEY ? 'explicit legacy override' : 'persisted Pulumi state'}.\n`
      );
  }
}
main().catch(() => {
  process.stderr.write(
    'CI deployment stopped; inspect the last phase and private prerequisites.\n'
  );
  process.exitCode = 1;
});
