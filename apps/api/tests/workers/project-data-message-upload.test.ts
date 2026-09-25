import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectDataTestDouble } from './support/expected-error-doubles';

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('large message upload through ProjectData', () => {
  it('commits one original message only after all parts arrive and deduplicates a lost ACK', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(`message-upload-${crypto.randomUUID()}`)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    const sessionId = await stub.createSession(null, 'Upload');
    const content = 'é🌊'.repeat(70_000);
    const metadata = JSON.stringify({ text: '🚀'.repeat(40_000) });
    const parts = content.match(/.{1,20000}/gu)!;
    const metadataParts = metadata.match(/.{1,20000}/gu)!;
    const identity = { sessionId, messageId: 'original-id' };

    await stub.storeMessageUploadPart({ ...identity, field: 'content', part: 0, data: parts[0]! });
    let page = await stub.getMessages(sessionId, 10);
    expect(page.messages).toEqual([]);

    for (const [part, data] of parts.entries()) {
      await stub.storeMessageUploadPart({ ...identity, field: 'content', part, data });
    }
    for (const [part, data] of metadataParts.entries()) {
      await stub.storeMessageUploadPart({ ...identity, field: 'toolMetadata', part, data });
    }
    const manifest = {
      ...identity,
      role: 'assistant',
      timestamp: '2026-09-25T00:00:00Z',
      origin: null,
      sequence: 1,
      contentParts: parts.length,
      metadataParts: metadataParts.length,
      contentSha256: await digest(content),
      metadataSha256: await digest(metadata),
    };
    expect((await stub.commitMessageUpload(manifest)).persisted).toBe(1);
    expect((await stub.commitMessageUpload(manifest)).duplicates).toBe(1);
    page = await stub.getMessages(sessionId, 10);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ id: 'original-id', role: 'assistant', content });
    expect(page.messages[0]?.toolMetadata).toEqual(JSON.parse(metadata));
  });
});
