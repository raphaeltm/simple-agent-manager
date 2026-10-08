import { log } from '../lib/logger';

// Protocol vocabulary, not caller-defined labels: never log paths, commands or errors.
export const LIFECYCLE_PHASES = [
  'packages',
  'docker',
  'docker-model-runner',
  'firewall',
  'tls-permissions',
  'nodejs-install',
  'devcontainer-cli',
  'image-prepull',
  'journald-config',
  'docker-restart',
  'metadata-block',
  'system_wait',
  'git_token',
  'runtime_assets',
  'workspace_prepare',
  'prepare',
  'wip_capture',
  'wip_upload',
  'home_capture',
  'home_upload',
  'complete',
  'metadata',
  'workspace',
  'home_restore',
  'git_restore',
  'agent_restore',
  'verify',
  'volume_create',
  'git_clone',
  'devcontainer_cache',
  'devcontainer_up',
  'gh_cli',
  'git_creds',
  'git_identity',
  'sam_env',
] as const;
const phases = new Set<string>(LIFECYCLE_PHASES);
export const LIFECYCLE_TIMINGS_MAX_BYTES = 8192;

export interface LifecycleTiming {
  phase: string;
  durationMs: number;
}

/** Drop unknown fields and labels even from authenticated agents. */
export function boundedLifecycleTimings(value: unknown): LifecycleTiming[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, LifecycleTiming>();
  for (const item of value.slice(0, LIFECYCLE_PHASES.length)) {
    if (!item || typeof item !== 'object') continue;
    const { phase, durationMs } = item;
    if (
      typeof phase !== 'string' ||
      !phases.has(phase) ||
      typeof durationMs !== 'number' ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0
    )
      continue;
    result.set(phase, { phase, durationMs });
  }
  return [...result.values()];
}

export function recordLifecycleTimings(
  operation: 'provision' | 'workspace' | 'sleep' | 'wake',
  timings: unknown,
  identity: { nodeId?: string | null; workspaceId?: string; chatSessionId?: string | null },
  outcome: 'success' | 'error' = 'success'
): void {
  // Keep the wire vocabulary compatible while avoiding the logger's sam_* token
  // redaction. Never relax credential redaction for a telemetry label.
  const phases = boundedLifecycleTimings(timings).map((timing) => ({
    ...timing,
    phase: timing.phase === 'sam_env' ? 'platform_environment' : timing.phase,
  }));
  if (phases.length)
    log.info('session_lifecycle.timings', { operation, outcome, ...identity, phases });
}
