import type { TaskRuntimeLivenessPort } from '@simple-agent-manager/project-data';

import {
  classifyTaskRuntimeDelivery,
  isSupersededTerminalReason,
  livenessEvidenceLogFields,
} from '../services/task-runtime-liveness';
import { getLocalTaskRuntimeLiveness } from '../services/task-runtime-liveness-local';
import { workerEnv } from './worker-env';

/** The shared task-runtime classifier, applied to ProjectData's own ACP state. */
export const taskLivenessPort: TaskRuntimeLivenessPort = {
  async getLocalTaskRuntimeVerdict(sql, env, task) {
    const liveness = await getLocalTaskRuntimeLiveness(sql, workerEnv(env), task);
    return {
      live: liveness.live,
      conclusive: liveness.conclusive,
      reason: liveness.reason,
      supersededTermination: isSupersededTerminalReason(liveness.reason),
      evidenceLogFields: livenessEvidenceLogFields(liveness),
      delivery: classifyTaskRuntimeDelivery(liveness),
    };
  },
};
