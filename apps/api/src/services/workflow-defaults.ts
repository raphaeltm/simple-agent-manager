export const WORKFLOW_DEFAULTS = {
  maxSteps: 25,
  maxParallelSteps: 2,
  maxLaunchesPerCycle: 2,
  repositoryCheckTimeoutMs: 5000,
  maxActiveRuns: 10,
  lifetimeMs: 72 * 60 * 60 * 1000,
  launchRetryLimit: 5,
  launchRetryBackoffMs: 30_000,
  handoffMaxChars: 8000,
} as const;

export const WORKFLOW_SETTING_DETAILS: Record<
  keyof typeof WORKFLOW_DEFAULTS,
  { description: string; max: number }
> = {
  maxSteps: { description: 'Maximum number of steps in one workflow plan.', max: 25 },
  maxParallelSteps: { description: 'Maximum agents running at once in one workflow.', max: 10 },
  maxLaunchesPerCycle: {
    description: 'Maximum workflow agents started per project scheduling cycle.',
    max: 5,
  },
  repositoryCheckTimeoutMs: {
    description: 'Maximum milliseconds for each workflow repository access check.',
    max: 10000,
  },
  maxActiveRuns: { description: 'Maximum active workflows per project.', max: 25 },
  lifetimeMs: {
    description: 'Maximum workflow lifetime in milliseconds before it needs attention.',
    max: 604800000,
  },
  launchRetryLimit: {
    description: 'Maximum attempts to confirm a step launch before it needs attention.',
    max: 10,
  },
  launchRetryBackoffMs: {
    description: 'Initial delay in milliseconds before retrying an uncertain step launch.',
    max: 300000,
  },
  handoffMaxChars: {
    description: 'Maximum summary characters passed between workflow steps.',
    max: 16000,
  },
};
