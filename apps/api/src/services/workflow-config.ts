import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';
import { WORKFLOW_DEFAULTS } from './workflow-defaults';

export async function getWorkflowConfig(env: Env) {
  const keys = Object.keys(WORKFLOW_DEFAULTS) as Array<keyof typeof WORKFLOW_DEFAULTS>;
  const values = await Promise.all(
    keys.map(
      async (key) => [key, Number(await resolveAdminSetting(env, `workflow.${key}`))] as const
    )
  );
  return Object.fromEntries(values) as Record<keyof typeof WORKFLOW_DEFAULTS, number>;
}
