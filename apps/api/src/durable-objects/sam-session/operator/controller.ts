import { resolveSamConfig } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { parsePositiveInt } from '../../../lib/route-helpers';
import { operations } from '../../../operations/registry';
import { OPERATOR_DEFAULTS } from '../../../services/admin-settings-registry';
import { getOperatorSettings, type OperatorSettings } from '../../../services/operator-settings';
import { runOperatorAgent } from './agent';
import {
  assertOperatorAccount,
  assertOperatorExecution,
  assertOperatorResource,
} from './operations';
import { actionProjection } from './projection';
import { OperatorStore } from './store';
import { OperatorWork } from './work';

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MESSAGE_MAX_LENGTH = 16_000;
const requestKey = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(/^[a-zA-Z0-9._:-]+$/)
);
const TurnInput = v.object({ requestKey, message: v.pipe(v.string(), v.minLength(1)) });
const SettingsInput = v.object({ enabled: v.boolean() });
const json = (body: unknown, status = 200) => Response.json(body, { status });
const reject = (error: string, message: string, status: number) =>
  json({ error, message, rejectedBeforeEffects: true }, status);

export class OperatorController {
  readonly store: OperatorStore;
  readonly work: OperatorWork;
  private runtimeSettings: OperatorSettings = { ...OPERATOR_DEFAULTS };
  private runner: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    sql: SqlStorage
  ) {
    this.store = new OperatorStore(sql, (fn) => ctx.storage.transactionSync(fn));
    this.work = new OperatorWork(sql, env);
  }

  enabled(): boolean {
    return !this.runtimeSettings.disabled && this.store.settings().enabled;
  }

  async handle(request: Request): Promise<Response | null> {
    this.runtimeSettings = await getOperatorSettings(this.env);
    this.work.configure(this.runtimeSettings);
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/settings') {
      if (request.method === 'PATCH') {
        const parsed = v.safeParse(SettingsInput, await request.json().catch(() => null));
        if (!parsed.success)
          return json({ error: 'invalid_input', message: 'enabled must be a boolean' }, 400);
        const userId = request.headers.get('x-sam-user-id');
        if (!userId) return reject('forbidden', 'User identity required', 403);
        await assertOperatorAccount(this.env, userId);
        this.store.bindUser(userId);
        this.ctx.storage.transactionSync(() => this.store.setEnabled(parsed.output.enabled));
        if (!parsed.output.enabled) this.abort?.abort();
      }
      if (request.method !== 'PATCH' && request.method !== 'GET')
        return json({ error: 'method_not_allowed' }, 405);
      return json({
        enabled: this.store.settings().enabled,
        available: !this.runtimeSettings.disabled,
      });
    }
    if (!this.enabled())
      return reject('sam_disabled', 'Enable SAM in your account settings to use it.', 403);
    if (path === '/fork' && request.method === 'POST') {
      const parsed = v.safeParse(v.object({ requestKey }), await request.json().catch(() => null));
      if (!parsed.success) return reject('invalid_input', 'A requestKey is required', 400);
      const userId = request.headers.get('x-sam-user-id');
      if (!userId || userId !== this.store.settings().userId)
        return reject('forbidden', 'User identity mismatch', 403);
      await assertOperatorExecution(this.env, userId);
      if (!this.enabled()) return reject('sam_disabled', 'SAM is disabled', 403);
      try {
        const config = resolveSamConfig(this.env as unknown as Record<string, string | undefined>);
        return json(
          this.store.fork(parsed.output.requestKey, {
            conversations: config.maxConversations,
            messages: config.maxMessagesPerConversation,
          })
        );
      } catch {
        return reject('conflict', 'Finish or cancel the active turn before branching', 409);
      }
    }
    if (path === '/turns' && request.method === 'GET') {
      const config = resolveSamConfig(this.env as unknown as Record<string, string | undefined>);
      const rawBefore = url.searchParams.get('before');
      let before: { createdAt: number; id: string } | undefined;
      try {
        if (rawBefore)
          before = v.parse(
            v.object({
              createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
              id: v.pipe(v.string(), v.uuid()),
            }),
            JSON.parse(atob(rawBefore))
          );
      } catch {
        return json({ error: 'invalid_input', message: 'Invalid history cursor' }, 400);
      }
      const rows = this.store.list(config.historyLoadLimit + 1, before);
      const hasMore = rows.length > config.historyLoadLimit;
      const turns = hasMore ? rows.slice(1) : rows;
      const oldest = turns[0];
      const userId = this.store.settings().userId;
      if (!userId) return reject('forbidden', 'User identity required', 403);
      const projectAction = actionProjection(this.env, userId);
      const projectedTurns = await Promise.all(
        turns.map(async (turn) => ({
          ...turn,
          actions: await Promise.all(this.store.actions(turn.id).map(projectAction)),
        }))
      );
      const work = await this.work.view(userId);
      await assertOperatorExecution(this.env, userId);
      if (!this.enabled()) return reject('sam_disabled', 'SAM is disabled', 403);
      return json({
        ...this.store.conversation(),
        work,
        turns: projectedTurns,
        nextCursor:
          hasMore && oldest
            ? btoa(JSON.stringify({ createdAt: oldest.created_at, id: oldest.id }))
            : null,
      });
    }
    if (path === '/turns' && request.method === 'POST') {
      const parsed = v.safeParse(TurnInput, await request.json().catch(() => null));
      if (
        !parsed.success ||
        !parsed.output.message.trim() ||
        parsed.output.message.length >
          parsePositiveInt(this.env.SAM_MESSAGE_MAX_LENGTH, DEFAULT_MESSAGE_MAX_LENGTH)
      )
        return reject('invalid_input', 'A bounded message and requestKey are required', 400);
      const userId = request.headers.get('x-sam-user-id');
      if (!userId) return reject('forbidden', 'User identity required', 403);
      await assertOperatorExecution(this.env, userId);
      this.store.bindUser(userId);
      if (!this.enabled()) return reject('sam_disabled', 'SAM is disabled', 403);
      let accepted;
      try {
        const config = resolveSamConfig(this.env as unknown as Record<string, string | undefined>);
        accepted = this.ctx.storage.transactionSync(() =>
          this.store.accept(parsed.output.requestKey, parsed.output.message, {
            limit: config.rateLimitRpm,
            windowMs: config.rateLimitWindowSeconds * 1000,
          })
        );
      } catch (error) {
        const rateLimited = error instanceof Error && error.message === 'RATE_LIMITED';
        const response = reject(
          'conflict',
          error instanceof Error ? error.message : 'Turn admission failed',
          rateLimited ? 429 : 409
        );
        if (rateLimited) {
          const config = resolveSamConfig(
            this.env as unknown as Record<string, string | undefined>
          );
          const windowMs = config.rateLimitWindowSeconds * 1000;
          response.headers.set(
            'Retry-After',
            String(Math.max(1, Math.ceil((windowMs - (Date.now() % windowMs)) / 1000)))
          );
        }
        return response;
      }
      // Durable recovery is armed before acknowledging acceptance to the browser.
      await this.ctx.storage.setAlarm(Date.now() + this.timeout());
      this.start();
      return json({ ...accepted, accepted: true }, accepted.replayed ? 200 : 202);
    }
    const seen = path.match(/^\/updates\/([^/]+)\/seen$/);
    if (seen?.[1] && request.method === 'POST') {
      const userId = request.headers.get('x-sam-user-id');
      if (!userId || userId !== this.store.settings().userId)
        return reject('forbidden', 'User identity mismatch', 403);
      await assertOperatorExecution(this.env, userId);
      const generation = this.store.settings().generation;
      await this.work.markSeen(userId, seen[1], () => {
        if (!this.enabled() || this.store.settings().generation !== generation)
          throw new Error('SAM disabled');
      });
      return json({ seen: true });
    }
    const cancel = path.match(/^\/turns\/([^/]+)\/cancel$/);
    if (cancel?.[1] && request.method === 'POST') {
      const turn = this.store.turn(cancel[1]);
      if (!turn) return json({ error: 'not_found', message: 'Turn not found' }, 404);
      if (turn.state === 'running' || turn.state === 'accepted') {
        this.store.setState(
          turn.id,
          'cancelled',
          null,
          'Cancelled by user. Already-dispatched project work continues.'
        );
        this.abort?.abort();
      }
      return json({ turn: this.store.turn(turn.id) });
    }
    const reconcile = path.match(/^\/actions\/([^/]+)\/reconcile$/);
    if (reconcile?.[1] && request.method === 'POST') {
      const userId = request.headers.get('x-sam-user-id');
      if (!userId || userId !== this.store.settings().userId)
        return reject('forbidden', 'User identity mismatch', 403);
      await assertOperatorExecution(this.env, userId);
      const action = this.store.action(reconcile[1]);
      if (!action || action.operation !== 'sam_chat_start')
        return reject('not_found', 'Dispatch action not found', 404);
      if (action.state !== 'uncertain')
        return json({ action: await actionProjection(this.env, userId)(action) });
      const operation = operations.find((item) => item.name === 'sam_chat_start');
      if (!operation) return reject('unavailable', 'Dispatch is unavailable', 503);
      const input = v.parse(operation.input, JSON.parse(action.input_json));
      try {
        const result = await operation.run(
          {
            env: this.env,
            actor: { userId, via: 'sam', scopes: new Set(['sam.read', 'sam.write']) },
            requestId: action.id,
            idempotencyKey: action.id,
            samDispatchReservation: {
              ...this.store.dispatchReservation(action.id),
              reconcileOnly: true,
            },
            assertEffectAllowed: async () => {
              await assertOperatorExecution(this.env, userId);
              await assertOperatorResource(this.env, userId, input);
              if (!this.enabled()) throw new Error('SAM disabled');
            },
            execCtx: { waitUntil: this.ctx.waitUntil.bind(this.ctx) } as ExecutionContext,
          },
          input as never
        );
        if (!this.enabled()) return reject('sam_disabled', 'SAM is disabled', 403);
        const uncertain =
          !!result &&
          typeof result === 'object' &&
          'dispatchState' in result &&
          result.dispatchState === 'uncertain';
        this.store.finishAction(action.id, uncertain ? 'uncertain' : 'completed', result);
      } catch {
        // An absent or inaccessible receipt cannot prove that no effect happened.
      }
      const updated = this.store.action(action.id);
      return json({ action: updated ? await actionProjection(this.env, userId)(updated) : null });
    }
    const confirmation = path.match(/^\/actions\/([^/]+)\/confirm$/);
    if (confirmation?.[1] && request.method === 'POST') {
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
      if (!userId || userId !== this.store.settings().userId)
        return json({ error: 'forbidden', message: 'User identity mismatch' }, 403);
      await assertOperatorExecution(this.env, userId);
      const action = this.store.action(confirmation[1]);
      const turn = action ? this.store.turn(action.turn_id) : null;
      if (!action || !turn) return json({ error: 'not_found', message: 'Action not found' }, 404);
      if (
        !this.enabled() ||
        turn.generation !== this.store.settings().generation ||
        turn.state === 'cancelled'
      )
        return json({ error: 'sam_disabled', message: 'This action is no longer authorized' }, 403);
      if (action.state !== 'approval_required')
        return json({ action: await actionProjection(this.env, userId)(action) });
      if (!parsed.output.approved) {
        this.store.finishAction(action.id, 'rejected', { message: 'Declined by user' });
        const updated = this.store.action(action.id);
        return json({ action: updated ? await actionProjection(this.env, userId)(updated) : null });
      }
      const operation = operations.find((item) => item.name === action.operation);
      if (!operation || operation.kind !== 'destructive')
        return json({ error: 'conflict', message: 'Action is no longer supported' }, 409);
      const input = v.parse(operation.input, JSON.parse(action.input_json));
      this.store.finishAction(action.id, 'uncertain', {
        message: 'User confirmed; outcome not yet confirmed',
      });
      try {
        const result = await operation.run(
          {
            env: this.env,
            actor: { userId, via: 'sam', scopes: new Set(['sam.read', 'sam.write']) },
            requestId: action.id,
            idempotencyKey: action.id,
            assertEffectAllowed: async () => {
              await assertOperatorExecution(this.env, userId);
              await assertOperatorResource(this.env, userId, input);
              if (
                !this.enabled() ||
                turn.generation !== this.store.settings().generation ||
                this.store.turn(turn.id)?.state === 'cancelled'
              )
                throw new Error('Action fenced');
            },
            execCtx: { waitUntil: this.ctx.waitUntil.bind(this.ctx) } as ExecutionContext,
          },
          input as never
        );
        this.store.finishAction(action.id, 'completed', result);
      } catch {
        // Keep uncertain outcomes reserved. A repeated confirmation never repeats the effect.
      }
      const updated = this.store.action(action.id);
      return json({ action: updated ? await actionProjection(this.env, userId)(updated) : null });
    }
    // Legacy inference is intentionally closed; old tabs cannot bypass the new action ledger.
    if (path === '/chat')
      return json(
        {
          error: 'client_update_required',
          message: 'Refresh SAM to use durable conversation turns.',
        },
        409
      );
    return null;
  }

  private timeout(): number {
    return parsePositiveInt(this.env.SAM_LLM_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS);
  }

  private start(): void {
    if (this.runner) return;
    this.runner = this.run().finally(() => {
      this.runner = null;
      this.abort = null;
      if (this.enabled() && this.store.active()?.state === 'accepted') this.start();
    });
    this.ctx.waitUntil(this.runner);
  }

  private async run(): Promise<void> {
    const turn = this.store.active();
    if (!turn || turn.state !== 'accepted') return;
    if (!this.enabled()) {
      this.store.setState(turn.id, 'cancelled', null, 'SAM is disabled');
      return;
    }
    const userId = this.store.settings().userId;
    if (!userId) return;
    this.store.setState(turn.id, 'running');
    log.info('sam.operator.turn_started', { userId, turnId: turn.id, generation: turn.generation });
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), this.timeout());
    const assertCurrent = () => {
      if (!this.enabled() || !this.store.isCurrent(turn) || this.abort?.signal.aborted)
        throw new Error('Turn fenced');
    };
    try {
      await assertOperatorExecution(this.env, userId);
      assertCurrent();
      const response = await runOperatorAgent({
        env: this.env,
        store: this.store,
        turn,
        userId,
        signal: this.abort.signal,
        assertCurrent,
        onFollowup: (projectId, sessionId) =>
          this.work.followup(projectId, sessionId, turn.generation),
        onDispatch: (id, projectId, result) =>
          this.work.track(id, projectId, result, turn.generation),
        executionContext: { waitUntil: this.ctx.waitUntil.bind(this.ctx) },
      });
      assertCurrent();
      this.store.setState(turn.id, 'completed', response);
    } catch (error) {
      log.warn('sam.operator.turn_interrupted', {
        userId,
        turnId: turn.id,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      if (this.store.turn(turn.id)?.state === 'running')
        this.store.setState(
          turn.id,
          'interrupted',
          null,
          'SAM could not finish this turn. Review recorded actions before continuing; uncertain actions are not automatically repeated.'
        );
    } finally {
      clearTimeout(timer);
      log.info('sam.operator.turn_finished', {
        userId,
        turnId: turn.id,
        state: this.store.turn(turn.id)?.state,
        durationMs: Date.now() - turn.created_at,
      });
      if (!this.store.active() || this.store.active()?.id === turn.id) {
        await this.scheduleWorkAlarm(this.store.settings().generation);
      }
    }
  }

  private async scheduleWorkAlarm(generation: number): Promise<void> {
    const next = this.work.nextAlarmAt(generation);
    if (next !== null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.runtimeSettings = await getOperatorSettings(this.env);
    this.work.configure(this.runtimeSettings);
    const active = this.store.active();
    if (!active) {
      const settings = this.store.settings();
      if (!this.enabled() || !settings.userId) return;
      const userId = settings.userId;
      await assertOperatorExecution(this.env, userId);
      await this.work.refresh(userId, settings.generation, async () => {
        await assertOperatorExecution(this.env, userId);
        if (!this.enabled() || this.store.settings().generation !== settings.generation)
          throw new Error('SAM disabled');
      });
      await this.scheduleWorkAlarm(settings.generation);
      return;
    }
    if (this.runner) {
      this.abort?.abort();
      await this.ctx.storage.setAlarm(Date.now() + this.timeout());
      return;
    }
    if (active.state === 'running') {
      this.store.setState(
        active.id,
        'interrupted',
        null,
        'Execution was interrupted. Recorded action receipts are preserved; reconcile uncertain outcomes before retrying.'
      );
      await this.scheduleWorkAlarm(this.store.settings().generation);
      return;
    }
    this.start();
  }
}
