/**
 * Every writer of `integration.*` platform settings and integration credentials must schedule an
 * owner security alert. The alert is attached at each route (the writers have no `waitUntil`), so
 * this scan makes the enumeration machine-checked: a new caller of a writer fails here until it
 * either alerts or is allowlisted with the reason it cannot write integration values.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const WRITER_CALL =
  /\b(savePlatformIntegrationConfig|completeSetupWithConfig|updateAdminSettings)\(/;

/** Callers that only ever pass non-integration setting names, with the reason. */
const NON_INTEGRATION_CALLERS: Record<string, string> = {
  'routes/admin-runtime-controls.ts': 'writes operations.* runtime switches only',
  'services/operational-kill-switch.ts': 'writes the operator kill switch only',
  'services/connector-settings.ts': 'writes connector.* settings only',
};

/** Files that define or re-export the writers rather than call them. */
const DEFINITIONS = new Set([
  'services/admin-settings-mutations.ts',
  'services/admin-settings.ts',
  'services/platform-config-core.ts',
  'services/platform-config.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('integration writer alert coverage', () => {
  it('every caller of an integration writer schedules a security alert or is allowlisted', () => {
    const callers = sourceFiles(SRC)
      .map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }))
      .filter(({ file, text }) => !DEFINITIONS.has(file) && WRITER_CALL.test(text));

    // A broken scan must not pass as "all clear".
    expect(callers.length).toBeGreaterThanOrEqual(6);

    const unalerted = callers
      .filter(({ file }) => !(file in NON_INTEGRATION_CALLERS))
      .filter(({ text }) => !text.includes('scheduleSecurityAlert('))
      .map(({ file }) => file);
    expect(unalerted).toEqual([]);

    for (const file of Object.keys(NON_INTEGRATION_CALLERS)) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, `${file} must not name integration settings`).not.toMatch(/['"`]integration\./);
    }
  });
});
