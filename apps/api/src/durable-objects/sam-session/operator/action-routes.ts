import * as v from 'valibot';

import type { Env } from '../../../env';
import { operations } from '../../../operations/registry';
import { assertOperatorExecution, assertOperatorResource } from './operations';
import { actionProjection } from './projection';
import type { OperatorStore } from './store';

const json = (body: unknown, status = 200) => Response.json(body, { status });
const reject = (error: string, message: string, status: number) =>
  json({ error, message, rejectedBeforeEffects: true }, status);

export interface ActionRouteContext {
  env: Env;
  store: OperatorStore;
  enabled: () => boolean;
  waitUntil: (promise: Promise<unknown>) => void;
}

/** User-driven action receipts: reconcile an uncertain dispatch, or confirm/decline an effect. */
export async function handleActionRoute(
  context: ActionRouteContext,
  request: Request,
  path: string
): Promise<Response | null> {
  const reconcile = path.match(/^\/actions\/([^/]+)\/reconcile$/);
  if (reconcile?.[1] && request.method === 'POST')
    return reconcileAction(context, request, reconcile[1]);
  const confirmation = path.match(/^\/actions\/([^/]+)\/confirm$/);
  if (confirmation?.[1] && request.method === 'POST')
    return confirmAction(context, request, confirmation[1]);
  return null;
}

async function reconcileAction(
  { env, store, enabled, waitUntil }: ActionRouteContext,
  request: Request,
  actionId: string
): Promise<Response> {
  const userId = request.headers.get('x-sam-user-id');
  if (!userId || userId !== store.settings().userId)
    return reject('forbidden', 'User identity mismatch', 403);
  await assertOperatorExecution(env, userId);
  const action = store.action(actionId);
  if (!action || action.operation !== 'sam_chat_start')
    return reject('not_found', 'Dispatch action not found', 404);
  if (action.state !== 'uncertain')
    return json({ action: await actionProjection(env, userId)(action) });
  const operation = operations.find((item) => item.name === 'sam_chat_start');
  if (!operation) return reject('unavailable', 'Dispatch is unavailable', 503);
  const checkedInput = v.safeParse(operation.input, JSON.parse(action.input_json));
  if (!checkedInput.success)
    return reject(
      'invalid_receipt',
      'Recorded action no longer matches its operation schema.',
      409
    );
  const input = checkedInput.output;
  try {
    const result = await operation.run(
      {
        env,
        actor: { userId, via: 'sam', scopes: new Set(['sam.read', 'sam.write']) },
        requestId: action.id,
        idempotencyKey: action.id,
        samDispatchReservation: {
          ...store.dispatchReservation(action.id),
          reconcileOnly: true,
        },
        assertEffectAllowed: async () => {
          await assertOperatorExecution(env, userId);
          await assertOperatorResource(env, userId, input);
          if (!enabled()) throw new Error('SAM disabled');
        },
        execCtx: { waitUntil } as ExecutionContext,
      },
      input as never
    );
    if (!enabled()) return reject('sam_disabled', 'SAM is disabled', 403);
    const uncertain =
      !!result &&
      typeof result === 'object' &&
      'dispatchState' in result &&
      result.dispatchState === 'uncertain';
    store.finishAction(action.id, uncertain ? 'uncertain' : 'completed', result);
  } catch {
    // An absent or inaccessible receipt cannot prove that no effect happened.
  }
  const updated = store.action(action.id);
  return json({ action: updated ? await actionProjection(env, userId)(updated) : null });
}

async function confirmAction(
  { env, store, enabled, waitUntil }: ActionRouteContext,
  request: Request,
  actionId: string
): Promise<Response> {
  const parsed = v.safeParse(
    v.object({ approved: v.boolean() }),
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return json(
      { error: 'invalid_input', message: 'An explicit approval choice is required' },
      400
    );
  const userId = request.headers.get('x-sam-user-id');
  if (!userId || userId !== store.settings().userId)
    return json({ error: 'forbidden', message: 'User identity mismatch' }, 403);
  await assertOperatorExecution(env, userId);
  const action = store.action(actionId);
  const turn = action ? store.turn(action.turn_id) : null;
  if (!action || !turn) return json({ error: 'not_found', message: 'Action not found' }, 404);
  if (!enabled() || turn.generation !== store.settings().generation || turn.state === 'cancelled')
    return json({ error: 'sam_disabled', message: 'This action is no longer authorized' }, 403);
  if (action.state !== 'approval_required')
    return json({ action: await actionProjection(env, userId)(action) });
  if (!parsed.output.approved) {
    store.finishAction(action.id, 'rejected', { message: 'Declined by user' });
    const updated = store.action(action.id);
    return json({ action: updated ? await actionProjection(env, userId)(updated) : null });
  }
  const operation = operations.find((item) => item.name === action.operation);
  if (!operation || operation.kind !== 'destructive')
    return json({ error: 'conflict', message: 'Action is no longer supported' }, 409);
  const checkedInput = v.safeParse(operation.input, JSON.parse(action.input_json));
  if (!checkedInput.success)
    return reject(
      'invalid_receipt',
      'Recorded action no longer matches its operation schema.',
      409
    );
  const input = checkedInput.output;
  store.finishAction(action.id, 'uncertain', {
    message: 'User confirmed; outcome not yet confirmed',
  });
  try {
    const result = await operation.run(
      {
        env,
        actor: { userId, via: 'sam', scopes: new Set(['sam.read', 'sam.write']) },
        requestId: action.id,
        idempotencyKey: action.id,
        assertEffectAllowed: async () => {
          await assertOperatorExecution(env, userId);
          await assertOperatorResource(env, userId, input);
          if (
            !enabled() ||
            turn.generation !== store.settings().generation ||
            store.turn(turn.id)?.state === 'cancelled'
          )
            throw new Error('Action fenced');
        },
        execCtx: { waitUntil } as ExecutionContext,
      },
      input as never
    );
    store.finishAction(action.id, 'completed', result);
  } catch {
    // Keep uncertain outcomes reserved. A repeated confirmation never repeats the effect.
  }
  const updated = store.action(action.id);
  return json({ action: updated ? await actionProjection(env, userId)(updated) : null });
}
