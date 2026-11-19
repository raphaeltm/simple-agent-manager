import type { CapacityPoolScope } from '@simple-agent-manager/shared';

export const DEFAULT_POOL_NAMES: Record<CapacityPoolScope, string> = {
  installation: 'Installation default',
  user: 'User default',
  project: 'Project default',
};

export const DEFAULT_POOL_STRATEGY = 'balanced';

export const DEFAULT_EXHAUSTION_POLICY = 'queue';
