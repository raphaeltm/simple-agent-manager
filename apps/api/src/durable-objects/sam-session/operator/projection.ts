import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../../../env';
import { requireProjectAccess } from '../../../middleware/project-auth';
import { operations } from '../../../operations/registry';
import { requireSessionWriter } from '../../../services/session-access';
import type { OperatorAction } from './store';

/** Request-local authorization cache. Stored resource payloads never become a visibility grant. */
export function actionProjection(env: Env, userId: string) {
  const access = new Map<string, Promise<boolean>>();
  const allowed = (projectId: string, sessionId?: string) => {
    const key = JSON.stringify([projectId, sessionId]);
    let result = access.get(key);
    if (!result) {
      result = (async () => {
        try {
          await requireProjectAccess(drizzle(env.DATABASE), projectId, userId);
          if (sessionId)
            await requireSessionWriter(env, projectId, sessionId, userId, {
              action: 'inspect this SAM action',
            });
          return true;
        } catch {
          return false;
        }
      })();
      access.set(key, result);
    }
    return result;
  };
  return async (action: OperatorAction): Promise<OperatorAction> => {
    // Aggregate/read payloads can contain multiple resources with different access rules.
    // The canonical private transcript preserves historical prose; read cards retain only status.
    if (operations.find((item) => item.name === action.operation)?.kind === 'read') {
      return { ...action, input_json: '{}', result_json: null };
    }
    let input: unknown;
    try {
      input = JSON.parse(action.input_json);
    } catch {
      input = null;
    }
    if (
      input &&
      typeof input === 'object' &&
      'projectId' in input &&
      typeof input.projectId === 'string'
    ) {
      const sessionId =
        'sessionId' in input && typeof input.sessionId === 'string' ? input.sessionId : undefined;
      if (await allowed(input.projectId, sessionId)) return action;
    }
    return {
      ...action,
      available: false,
      input_json: '{}',
      result_json: JSON.stringify({
        message:
          'Resource details are no longer accessible. The receipt is retained for your records.',
      }),
    };
  };
}
