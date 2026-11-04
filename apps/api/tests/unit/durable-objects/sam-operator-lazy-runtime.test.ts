import { afterEach, expect, it, vi } from 'vitest';

import type { operatorTools } from '../../../src/durable-objects/sam-session/operator/operations';

afterEach(() => {
  vi.doUnmock('@mastra/core/agent');
  vi.doUnmock('@mastra/core/llm');
  vi.doUnmock('@mastra/core/tools');
  vi.resetModules();
});

it('loads operator handlers without initializing inference providers or tools', async () => {
  vi.resetModules();
  const initialized = vi.fn();
  for (const module of ['@mastra/core/agent', '@mastra/core/llm', '@mastra/core/tools']) {
    vi.doMock(module, () => {
      initialized(module);
      return {};
    });
  }

  await Promise.all([
    import('../../../src/durable-objects/sam-session/operator/controller'),
    import('../../../src/durable-objects/sam-session/operator/agent'),
    import('../../../src/durable-objects/sam-session/operator/model'),
    import('../../../src/durable-objects/sam-session/operator/operations'),
  ]);

  expect(initialized).not.toHaveBeenCalled();
}, 30_000);

it('does not construct tools if a turn is cancelled while the runtime loads', async () => {
  vi.resetModules();
  let release!: () => void;
  let loaded!: () => void;
  const loading = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createTool = vi.fn();
  vi.doMock('@mastra/core/tools', async () => {
    loaded();
    await gate;
    return { createTool };
  });
  const { operatorTools: loadTools } =
    await import('../../../src/durable-objects/sam-session/operator/operations');
  let current = true;
  const pending = loadTools({
    assertCurrent: () => {
      if (!current) throw new Error('Turn fenced');
    },
  } as Parameters<typeof operatorTools>[0]);
  await loading;
  current = false;
  const rejected = expect(pending).rejects.toThrow('Turn fenced');
  release();
  await rejected;
  expect(createTool).not.toHaveBeenCalled();
}, 30_000);
