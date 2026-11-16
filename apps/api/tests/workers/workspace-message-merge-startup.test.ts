import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { env, SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

import { signCurrentWorkspaceCallbackToken } from '../../src/services/jwt';
import { chunks, contents, deliver, startup } from './helpers/merge-reporter-workspace';

afterEach(() => vi.restoreAllMocks());

it('merges reporter chunks after real workspace reservation and current callback authentication', async () => {
  const f = await startup();
  expect(await deliver(f, chunks(f, ['first ', 'second']))).toMatchObject({
    persisted: 2,
    duplicates: 0,
  });
  expect(await contents(f)).toEqual(['first second']);
});

it('retains per-message inserts for old or malformed reporters through the real callback route', async () => {
  for (const incarnation of [null, 'not-a-uuid']) {
    const f = await startup();
    const messages = chunks(f, ['first ', 'second']);
    expect(await deliver(f, messages, incarnation)).toMatchObject({ persisted: 2, duplicates: 0 });
    expect(await contents(f)).toEqual(['first ', 'second']);
    expect(await deliver(f, messages, incarnation)).toMatchObject({ persisted: 0, duplicates: 2 });
  }
});

it('accepts new low sequences from a recreated outbox instead of dropping new content', async () => {
  const f = await startup();
  await deliver(f, chunks(f, ['original ', 'reply']));
  await deliver(f, chunks(f, ['new ', 'reply'], 1, 'recreated'), crypto.randomUUID());
  expect(await contents(f)).toEqual(['original reply', 'new reply']);
});

it('deduplicates a delayed retired-outbox batch after its IDs leave the recent ring', async () => {
  const f = await startup();
  vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 50,
  });
  const original = chunks(
    f,
    Array.from({ length: 100 }, (_, i) => `old${i} `)
  );
  const replacement = chunks(
    f,
    Array.from({ length: 100 }, (_, i) => `new${i} `),
    1,
    'new'
  );
  for (let start = 0; start < 100; start += 20) await deliver(f, original.slice(start, start + 20));
  const replacementId = crypto.randomUUID();
  for (let start = 0; start < 100; start += 20)
    await deliver(f, replacement.slice(start, start + 20), replacementId);
  const before = await contents(f);
  expect(before).toHaveLength(2);
  expect(await deliver(f, original.slice(0, 7))).toMatchObject({ persisted: 0, duplicates: 7 });
  expect(await contents(f)).toEqual(before);
});

it('falls back to plain inserts when new incarnation receipts exceed the configured state budget', async () => {
  const f = await startup();
  vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
    enabled: true,
    maxRowBytes: 1024,
    recentIds: 50,
  });
  const first = chunks(f, ['first ', 'reply'], 1, '00');
  await deliver(f, first);
  let expected = 'first reply';
  for (let index = 1; index <= 20; index++) {
    const text = [`new${index} `, 'reply'];
    expected += text.join('');
    const messages = chunks(f, text, 1, String(index).padStart(2, '0')).map((message, offset) => ({
      ...message,
      timestamp: new Date(Date.parse(f.now) + index * 10 + offset).toISOString(),
    }));
    await deliver(f, messages, crypto.randomUUID());
  }
  const before = await contents(f);
  expect(before.length).toBeGreaterThan(21);
  expect(before.join('')).toBe(expected);
  expect(await deliver(f, first)).toMatchObject({ persisted: 0, duplicates: 2 });
  expect(await contents(f)).toEqual(before);
});

it('keeps historical same-incarnation retries byte-identical across changed batch boundaries', async () => {
  const f = await startup();
  vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 50,
  });
  const messages = chunks(
    f,
    Array.from({ length: 100 }, (_, i) => `part${i} `)
  );
  for (let start = 0; start < messages.length; start += 20)
    await deliver(f, messages.slice(start, start + 20));
  const before = await contents(f);
  expect(before).toHaveLength(1);
  expect(await deliver(f, messages.slice(0, 7))).toMatchObject({ persisted: 0, duplicates: 7 });
  expect(await deliver(f, messages.slice(5, 30))).toMatchObject({ persisted: 0, duplicates: 25 });
  expect(await contents(f)).toEqual(before);
});

it('treats null-to-rotated callback generation as a new identity and rejects the retired callback', async () => {
  const f = await startup();
  await deliver(f, chunks(f, ['initial ', 'reply']));
  const generation = crypto.randomUUID();
  await env.DATABASE.prepare('UPDATE workspaces SET callback_generation = ? WHERE id = ?')
    .bind(generation, f.workspace)
    .run();
  const token = await signCurrentWorkspaceCallbackToken(f.workspace, env);
  await deliver(f, chunks(f, ['rotated ', 'reply'], 1, 'rotated'), f.incarnation, token);
  expect(await contents(f)).toEqual(['initial reply', 'rotated reply']);
  const retired = await SELF.fetch(
    `https://api.test.example.com/api/workspaces/${f.workspace}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chunks(f, ['retired'], 3, 'retired') }),
    }
  );
  expect(retired.status).toBe(401);
});
