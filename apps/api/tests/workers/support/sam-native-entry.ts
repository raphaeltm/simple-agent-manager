/** Test-only inspection RPCs; production exports the unmodified SamSession. */
import { SamSession } from '../../../src/durable-objects/sam-session';

export class SamSessionRuntime extends SamSession {
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
