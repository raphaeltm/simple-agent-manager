/**
 * Source contract tests for the POST /workspaces/:id/messages batch endpoint.
 *
 * Verifies the route handler implements required validation, auth, and delegation
 * by inspecting the source code for expected patterns.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspace messages batch endpoint source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');

  it('defines the batch messages POST endpoint', () => {
    expect(file).toContain("workspacesRoutes.post('/:id/messages'");
  });

  it('uses callback JWT auth (not user auth)', () => {
    // The /messages path is in the callback auth bypass list
    expect(file).toContain("path.endsWith('/messages')");
    // The handler calls verifyWorkspaceCallbackAuth
    expect(file).toContain('verifyWorkspaceCallbackAuth(c, workspaceId)');
  });

  it('validates messages array is present and non-empty', () => {
    expect(file).toContain("'messages array is required'");
    expect(file).toContain("'messages array must not be empty'");
  });

  it('enforces maximum 100 messages per batch', () => {
    expect(file).toContain('body.messages.length > 100');
    expect(file).toContain("'Maximum 100 messages per batch'");
  });

  it('validates role enum (user, assistant, system, tool)', () => {
    expect(file).toContain("const validRoles = new Set(['user', 'assistant', 'system', 'tool'])");
    expect(file).toContain('!validRoles.has(msg.role)');
  });

  it('validates required message fields', () => {
    expect(file).toContain("'Each message must have a messageId string'");
    expect(file).toContain("'Each message must have a sessionId string'");
    expect(file).toContain("'Each message must have non-empty content'");
    expect(file).toContain("'Each message must have a timestamp string'");
  });

  it('requires all messages to target the same sessionId', () => {
    expect(file).toContain("'All messages in a batch must target the same sessionId'");
  });

  it('enforces payload size limit', () => {
    expect(file).toContain('256 * 1024');
    expect(file).toContain('Payload exceeds');
  });

  it('resolves workspace to project via D1', () => {
    expect(file).toContain('schema.workspaces.projectId');
    expect(file).toContain("'Workspace is not linked to a project'");
  });

  it('delegates to persistMessageBatch on ProjectData DO', () => {
    expect(file).toContain('projectDataService.persistMessageBatch');
  });

  it('returns persisted and duplicates counts', () => {
    expect(file).toContain('persisted: result.persisted');
    expect(file).toContain('duplicates: result.duplicates');
  });
});
