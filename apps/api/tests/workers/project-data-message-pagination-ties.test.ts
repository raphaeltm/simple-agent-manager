import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectDataTestDouble } from './support/expected-error-doubles';

type Cursor = { createdAt: number; sequence: number; id: string };
function cursor(row: Record<string, unknown>): Cursor {
  return { createdAt: Number(row.createdAt), sequence: Number(row.sequence), id: String(row.id) };
}

describe('ProjectData message pagination with tied timestamps', () => {
  it('reads every row in both directions across exact page and tie boundaries', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(`pagination-ties-${crypto.randomUUID()}`)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    const sessionId = await stub.createSession(null, 'Tied messages');
    const seed = Array.from({ length: 8 }, (_, index) => ({
      messageId: `tie-${index}`,
      role: 'assistant',
      content: `content-${index}`,
      toolMetadata: null,
      timestamp: new Date(1_000_000 + Math.floor(index / 5) * 1_000).toISOString(),
      sequence: index + 1,
    }));
    await stub.persistMessageBatch(sessionId, seed);

    let after: Cursor | null = null;
    const forward: string[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await stub.getMessages(sessionId, 2, null, after, undefined, false, 'asc');
      if (result.messages.length === 0) break;
      forward.push(...result.messages.map((row) => String(row.id)));
      const next = cursor(result.messages.at(-1) as Record<string, unknown>);
      expect(next).not.toEqual(after);
      after = next;
      if (!result.hasMore) break;
    }
    expect(forward).toEqual(seed.map((row) => row.messageId));

    let before: Cursor | null = null;
    const backward: string[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await stub.getMessages(sessionId, 2, before, null, undefined, false, 'desc');
      if (result.messages.length === 0) break;
      backward.unshift(...result.messages.map((row) => String(row.id)));
      const next = cursor(result.messages[0] as Record<string, unknown>);
      expect(next).not.toEqual(before);
      before = next;
      if (!result.hasMore) break;
    }
    expect(backward).toEqual(seed.map((row) => row.messageId));

    const repeated = await stub.getMessages(sessionId, 2, before, null, undefined, false, 'desc');
    expect(repeated.messages).toEqual([]);
    const numeric = await stub.getMessages(
      sessionId,
      20,
      1_000_000,
      null,
      undefined,
      false,
      'desc'
    );
    expect(numeric.messages.map((row) => row.id)).toEqual([]);
  });
});
