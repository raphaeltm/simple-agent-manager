import {
  assertWorkerDeployDiagnostics,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type EngineRunner,
  type InstallerEngineConfig,
} from './installer-engine-contract.js';

export async function deployEngineApi(
  config: InstallerEngineConfig,
  runner: EngineRunner,
  root: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const diagnostics = await runner.run(
    {
      executable: 'pnpm',
      args: [
        '--filter',
        '@simple-agent-manager/api',
        'exec',
        'wrangler',
        'deploy',
        '--env',
        config.environment,
        '--tag',
        config.sourceCommit,
        '--message',
        `commit:${config.sourceCommit}`,
      ],
    },
    {
      cwd: root,
      env,
      timeoutMs: config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      includeStderr: true,
    }
  );
  assertWorkerDeployDiagnostics(diagnostics, env.ARTIFACTS_BINDING_ENABLED === 'true');
}
