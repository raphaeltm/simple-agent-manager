import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startArchitectureServer } from '../src';

const PLAYWRIGHT_PORT = Number(process.env.ARCHITECTURE_PLAYWRIGHT_PORT ?? 49173);
const FIXTURE_ROOT = path.resolve(
  process.cwd(),
  '../../.codex/tmp/architecture-playwright-fixture'
);

await resetFixture();
const running = await startArchitectureServer({
  port: PLAYWRIGHT_PORT,
  repoRoot: FIXTURE_ROOT,
  watchIntervalMs: 100,
  workspaceRoot: path.join(FIXTURE_ROOT, 'architecture'),
});

console.log(`Architecture Playwright server listening at ${running.url}`);

async function resetFixture(): Promise<void> {
  await rm(FIXTURE_ROOT, { force: true, recursive: true });
  await mkdir(path.join(FIXTURE_ROOT, 'architecture'), { recursive: true });
  await mkdir(path.join(FIXTURE_ROOT, 'src'), { recursive: true });
  await writeFile(
    path.join(FIXTURE_ROOT, 'src/api.ts'),
    'export const hello = "world";\nexport const long = true;\n'
  );
  await writeFile(path.join(FIXTURE_ROOT, 'architecture/model.yaml'), normalModel('API component'));
}

function normalModel(apiTitle: string): string {
  return `
version: 1
name: Playwright Architecture
description: Browser fixture
elements:
  - id: root
    kind: system
    title: Root system
  - id: api
    parent: root
    kind: component
    title: ${apiTitle}
    sourceRefs:
      - path: src/api.ts
        startLine: 1
  - id: worker
    parent: root
    kind: runtime
    title: Worker runtime with a deliberately long URL https://example.com/${'x'.repeat(120)}
relationships:
  - id: api-worker
    from: api
    to: worker
    title: API calls Worker
flows:
  - id: request-flow
    title: Request flow
    steps:
      - id: select
        title: Select API
        element: api
      - id: call
        title: Call Worker
        relationship: api-worker
stateMachines:
  - id: task-state
    title: Task state
    element: api
    states:
      - id: queued
        title: Queued
      - id: running
        title: Running
    transitions:
      - from: queued
        to: running
        event: start
`;
}

process.once('SIGTERM', () => void running.close().then(() => process.exit(0)));
process.once('SIGINT', () => void running.close().then(() => process.exit(0)));
