import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { backfillDefaultCapacityPoolsForExistingCredentials } from '../services/default-capacity-pools';

export interface ScheduledCapacityPoolReconciliationResult {
  installationEnsured: boolean;
  usersEnsured: number;
  projectsEnsured: number;
}

export async function runScheduledCapacityPoolReconciliation(
  env: Env
): Promise<ScheduledCapacityPoolReconciliationResult> {
  const db = drizzle(env.DATABASE, { schema });
  const result = await backfillDefaultCapacityPoolsForExistingCredentials(db, {
    includeInstallation: true,
    env,
  });

  return {
    installationEnsured: result.installation !== null,
    usersEnsured: result.usersEnsured,
    projectsEnsured: result.projectsEnsured,
  };
}
