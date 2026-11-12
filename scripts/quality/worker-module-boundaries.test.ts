// Proves the worker-modularization boundary rules in eslint.config.mjs fire, through the real
// ESLint configuration. See tasks/active/2026-11-12-worker-modularization.md, "Rules for every
// workstream" (2. Boundaries).
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: repoRoot });

async function restrictedImportMessages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });
  expect(result, `ESLint returned no result for ${filePath}`).toBeDefined();
  // A fatal parse error would also produce "no restricted-import messages"; fail loudly instead.
  expect(result?.messages.filter((m) => m.fatal)).toEqual([]);
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

const PACKAGE_FILE = 'packages/worker-core/src/boundary-probe.ts';
const WORKER_FILE = 'apps/api/src/boundary-probe.ts';
const WORKER_TEST_FILE = 'apps/api/tests/unit/boundary-probe.test.ts';

describe('boundary 1: packages never import from apps', () => {
  it.each([
    "import { x } from '../../../apps/api/src/env';",
    "import { x } from '../../apps/web/src/lib/api';",
    "import { x } from '@simple-agent-manager/api';",
    "import { x } from '@simple-agent-manager/api/src/env';",
    "import { x } from '@simple-agent-manager/web';",
    "export { x } from '../../../apps/api/src/env';",
  ])('rejects %s', async (code) => {
    expect(await restrictedImportMessages(PACKAGE_FILE, code)).toHaveLength(1);
  });

  it('applies to package tests too', async () => {
    const code = "import { x } from '../../../../apps/api/src/env';";
    expect(
      await restrictedImportMessages('packages/worker-core/tests/unit/probe.test.ts', code)
    ).toHaveLength(1);
  });

  it.each([
    "import { x } from './logger';",
    "import { x } from '@simple-agent-manager/shared';",
    "import { x } from 'drizzle-orm';",
    // A package whose name merely starts like an app name is not an app.
    "import { x } from '@simple-agent-manager/api-client';",
  ])('allows %s', async (code) => {
    expect(await restrictedImportMessages(PACKAGE_FILE, code)).toEqual([]);
  });
});

describe('boundary 2: the worker imports packages only through public entry points', () => {
  it.each([
    "import { x } from '@simple-agent-manager/worker-core/src/logger';",
    "import { x } from '@simple-agent-manager/worker-core/dist/logger.js';",
    "import { x } from '@simple-agent-manager/providers/src';",
    "import { x } from '../../../packages/worker-core/src/logger';",
    "export * from '@simple-agent-manager/worker-core/src/schema';",
  ])('rejects %s', async (code) => {
    expect(await restrictedImportMessages(WORKER_FILE, code)).toHaveLength(1);
  });

  it.each([
    "import { x } from '../../../../packages/worker-core/src/logger';",
    "import { x } from '../../../../packages/shared/src/agent-install-manifest.json';",
    "import { x } from '@simple-agent-manager/providers/tests/fixtures/hetzner-mocks';",
  ])('applies to worker tests too: rejects %s', async (code) => {
    expect(await restrictedImportMessages(WORKER_TEST_FILE, code)).toHaveLength(1);
  });

  it("lets worker tests share a package's test fixtures, and only from tests", async () => {
    const code = "import { x } from '../../../../../packages/providers/tests/fixtures/hetzner-mocks';";
    expect(await restrictedImportMessages(WORKER_TEST_FILE, code)).toEqual([]);
    expect(await restrictedImportMessages(WORKER_FILE, code)).toHaveLength(1);
  });

  it.each([
    "import { x } from '@simple-agent-manager/worker-core';",
    "export * from '@simple-agent-manager/worker-core/schema';",
    "import { x } from '@simple-agent-manager/shared';",
    "import { x } from '../lib/logger';",
  ])('allows %s', async (code) => {
    expect(await restrictedImportMessages(WORKER_FILE, code)).toEqual([]);
  });
});
