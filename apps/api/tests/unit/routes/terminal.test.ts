import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/terminal.ts'), 'utf8');

  it('allows running, recovery, and creating workspace statuses for terminal tokens', () => {
    expect(file).toContain("ws.status !== 'running' && ws.status !== 'recovery' && ws.status !== 'creating'");
    expect(file).toContain('Workspace is not accessible');
  });
});
