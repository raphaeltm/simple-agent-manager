import type { Env } from '../env';
import { errors } from '../middleware/error';
import { runCloudflareRuntimePhase } from './cloudflare-runtime-phase';

export function getSandboxConfig(env: Env) {
  return {
    enabled: env.SANDBOX_ENABLED === 'true',
    execTimeoutMs: Number.parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '30000', 10),
    gitTimeoutMs: Number.parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '120000', 10),
    sleepAfter: env.SANDBOX_SLEEP_AFTER || '10m',
  };
}

export function requireSandbox(env: Env): void {
  const config = getSandboxConfig(env);
  if (!config.enabled) {
    throw errors.badRequest('Sandbox prototype is disabled. Set SANDBOX_ENABLED=true to enable.');
  }
  if (!env.SANDBOX) {
    throw errors.badRequest(
      'SANDBOX binding not available. The Containers binding may not be configured on this environment.'
    );
  }
}

export async function getSandboxInstance(env: Env, sandboxId: string) {
  try {
    const { getSandbox } = await import('@cloudflare/sandbox');
    if (!env.SANDBOX) {
      throw errors.badRequest('SANDBOX binding not available.');
    }
    return getSandbox(env.SANDBOX, sandboxId);
  } catch (err) {
    throw errors.internal(
      `Failed to initialize Sandbox SDK: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function destroySandboxInstance(
  env: Env,
  sandboxId: string,
  detail: { nodeId?: string; workspaceId?: string; sandboxId?: string } = {}
): Promise<void> {
  requireSandbox(env);
  const config = getSandboxConfig(env);
  const sandbox = await getSandboxInstance(env, sandboxId);
  await runSandboxPhase('destroy', { sandboxId, ...detail }, () =>
    withTimeout(
      sandbox.destroy(),
      config.execTimeoutMs,
      `Sandbox destroy timed out after ${config.execTimeoutMs}ms`
    )
  );
}

export function shellQuote(value: string): string {
  const escapedSingleQuote = String.raw`'\''`;
  return `'${value.replaceAll("'", escapedSingleQuote)}'`;
}

export async function runSandboxPhase<T>(
  phase: string,
  detail: { nodeId?: string; workspaceId?: string; sandboxId?: string },
  fn: () => Promise<T>
): Promise<T> {
  return runCloudflareRuntimePhase(
    {
      start: 'cf_vm_agent_phase_start',
      success: 'cf_vm_agent_phase_success',
      error: 'cf_vm_agent_phase_error',
    },
    phase,
    detail,
    fn
  );
}
