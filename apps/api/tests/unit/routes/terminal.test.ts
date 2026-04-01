import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('terminal routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/terminal.ts'), 'utf8');

  it('allows running, recovery, and creating workspace statuses for terminal tokens', () => {
    expect(file).toContain("ws.status !== 'running' && ws.status !== 'recovery' && ws.status !== 'creating'");
    expect(file).toContain('Workspace is not accessible');
  });

  it('records terminal activity when issuing tokens', () => {
    expect(file).toContain('projectDataService.updateTerminalActivity');
  });

  it('exposes a POST /activity endpoint for frontend heartbeats', () => {
    expect(file).toContain("terminalRoutes.post('/activity'");
    expect(file).toContain('body.workspaceId');
    expect(file).toContain('projectDataService.updateTerminalActivity');
  });

  it('validates workspaceId is required on activity endpoint', () => {
    expect(file).toContain('jsonValidator(TerminalRequestSchema)');
  });

  it('skips activity tracking when workspace has no projectId', () => {
    expect(file).toContain('if (ws.projectId)');
  });

  it('uses waitUntil for fire-and-forget terminal activity on token endpoint', () => {
    expect(file).toContain('c.executionCtx.waitUntil');
    expect(file).toContain('updateTerminalActivity');
  });
});
