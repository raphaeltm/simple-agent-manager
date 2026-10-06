import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('task agent profile display responses', () => {
  it('keeps authenticated task CRUD responses on the display resolver path', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/routes/tasks/crud.ts'), 'utf8');

    expect(source).toContain('async function toDisplayTaskResponse');
    expect(source).not.toMatch(/return c\.json\(toTaskResponse\(/);
  });
});
