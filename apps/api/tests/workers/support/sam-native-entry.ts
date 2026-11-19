/** Test-only inspection RPCs; production exports the unmodified SamSession. */
import { SamSession } from '../../../src/durable-objects/sam-session';
import type { Env } from '../../../src/env';

const realNow = Date.now;

export class SamSessionRuntime extends SamSession {
  private readonly pending: Set<Promise<unknown>>;

  constructor(ctx: DurableObjectState, env: Env) {
    const pending = new Set<Promise<unknown>>();
    const waitUntil = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (promise: Promise<unknown>) => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise)
      );
      waitUntil(promise);
    };
    super(ctx, env);
    this.pending = pending;
  }

  // Node's fake clock cannot reach this separate workerd isolate. Leave actual
  // timers running: only the fixed-window admission clock needs controlling.
  testSetTime(now: number | null) {
    Date.now = now === null ? realNow : () => now;
  }

  async testDrain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  testSql(query: string, values: SqlStorageValue[] = []) {
    return this.ctx.storage.sql.exec(query, ...values).toArray();
  }

  testEnvironment(values: Record<string, string>) {
    Object.assign(this.env, values);
  }

  async testAlarm() {
    await this.ctx.storage.deleteAlarm();
    await this.alarm();
  }
}

export default {
  fetch() {
    return new Response('Native SAM test runtime');
  },
};
