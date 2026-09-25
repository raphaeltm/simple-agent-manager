import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { storeMessageUploadPart } from '../../src/durable-objects/project-data/message-upload';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
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

  it('keeps an interrupted upload available for exact internal readback after abandonment', async () => {
    const projectId = `message-upload-quarantine-${crypto.randomUUID()}`;
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession(null, 'Interrupted upload');
    const messageId = 'interrupted';
    const data = '🌊'.repeat(100);
    await stub.storeMessageUploadPart({ sessionId, messageId, field: 'content', part: 0, data });
    await stub.stopSession(sessionId);
    const now = Date.now() + 60_000;
    const prepared = await stub.archiveSourcePrepareIntent({
      projectId,
      sessionId,
      migrationId: crypto.randomUUID(),
      sourceOwnerName: projectId,
      targetOwnerName: `${projectId}:archive:g1:s0`,
      targetGeneration: 1,
      sourceIntentToken: crypto.randomUUID(),
      now,
      minTerminalAgeMs: 0,
    });
    expect('refused' in prepared).toBe(false);
    const record = await stub.readMessageUploadQuarantine(sessionId, messageId);
    expect(record).toMatchObject({ status: 'abandoned', abandonedAt: now });
    expect(record?.fields).toEqual([
      { field: 'content', part: 0, data, sha256: await digest(data) },
    ]);
    expect((await stub.getMessages(sessionId, 10)).messages).toEqual([]);
  });

  it('bounds aggregate staged bytes across sessions without deleting existing parts', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(`message-upload-limit-${crypto.randomUUID()}`)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    const firstSession = await stub.createSession(null, 'First');
    const secondSession = await stub.createSession(null, 'Second');
    const limitedEnv = {
      ...env,
      MAX_MESSAGE_UPLOAD_STAGED_BYTES: '8',
    } as ProjectDataEnv;
    await runInDurableObject(stub, async (_instance, state) => {
      storeMessageUploadPart(state.storage.sql, limitedEnv, {
        sessionId: firstSession,
        messageId: 'first',
        field: 'content',
        part: 0,
        data: '123456',
      });
      expect(() =>
        storeMessageUploadPart(state.storage.sql, limitedEnv, {
          sessionId: secondSession,
          messageId: 'second',
          field: 'content',
          part: 0,
          data: '789',
        })
      ).toThrow('Project upload quarantine exceeds size limit');
    });
    expect((await stub.readMessageUploadQuarantine(firstSession, 'first'))?.fields[0]?.data).toBe(
      '123456'
    );
    const partLimitedEnv = {
      ...env,
      MAX_MESSAGE_UPLOAD_STAGED_BYTES: '100',
      MAX_MESSAGE_UPLOAD_STAGED_PARTS: '1',
    } as ProjectDataEnv;
    await runInDurableObject(stub, async (_instance, state) => {
      expect(() =>
        storeMessageUploadPart(state.storage.sql, partLimitedEnv, {
          sessionId: secondSession,
          messageId: 'second',
          field: 'content',
          part: 0,
          data: '7',
        })
      ).toThrow('Project upload quarantine exceeds part limit');
    });
  });

  it('pages every quarantined message ID and reads back the last record', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(`message-upload-inventory-${crypto.randomUUID()}`)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    const sessionId = await stub.createSession(null, 'Inventory');
    await runInDurableObject(stub, async (_instance, state) => {
      for (let index = 0; index < 120; index++) {
        state.storage.sql.exec(
          'INSERT INTO message_upload_parts (session_id, message_id, field, part, data, created_at, abandoned_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          sessionId,
          `message-${String(index).padStart(3, '0')}`,
          'content',
          0,
          `part-${index}`,
          1234,
          5678
        );
      }
    });
    const first = await stub.listMessageUploadQuarantine(100, null);
    expect(first.uploads).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await stub.listMessageUploadQuarantine(100, first.nextCursor);
    expect(second.uploads).toHaveLength(20);
    expect(second.nextCursor).toBeNull();
    const last = second.uploads.at(-1)!;
    expect(last.messageId).toBe('message-119');
    expect((await stub.readMessageUploadQuarantine(sessionId, last.messageId))?.fields[0]).toEqual({
      field: 'content',
      part: 0,
      data: 'part-119',
      sha256: await digest('part-119'),
    });
  });
});
