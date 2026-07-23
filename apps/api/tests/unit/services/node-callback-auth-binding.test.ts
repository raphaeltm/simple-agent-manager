import { describe, expect, it } from 'vitest';

import type { CallbackTokenPayload } from '../../../src/services/jwt';
import {
  callbackTokenMatchesNode,
  callbackTokenMatchesWorkspace,
  nodeStatusBlocksTokenRefresh,
} from '../../../src/services/node-callback-auth';

const nodeToken = (workspace: string): CallbackTokenPayload => ({
  workspace,
  type: 'callback',
  scope: 'node',
});
const workspaceToken = (workspace: string): CallbackTokenPayload => ({
  workspace,
  type: 'callback',
  scope: 'workspace',
});
const legacyToken = (workspace: string): CallbackTokenPayload => ({
  workspace,
  type: 'callback',
});

describe('callbackTokenMatchesNode', () => {
  it('matches a node-scoped token bound to exactly that node', () => {
    expect(callbackTokenMatchesNode(nodeToken('node-1'), 'node-1')).toBe(true);
  });

  it('rejects a node-scoped token bound to a different node (cross-tenant forgery)', () => {
    expect(callbackTokenMatchesNode(nodeToken('node-999'), 'node-1')).toBe(false);
  });

  it('rejects a workspace-scoped token even when the value collides', () => {
    // scope must be 'node' — a workspace token whose workspace happens to equal a nodeId string
    // must never authorize node-level action.
    expect(callbackTokenMatchesNode(workspaceToken('node-1'), 'node-1')).toBe(false);
  });

  it('rejects legacy (no-scope) tokens', () => {
    expect(callbackTokenMatchesNode(legacyToken('node-1'), 'node-1')).toBe(false);
  });

  it('is false for null/undefined target node (fails closed)', () => {
    expect(callbackTokenMatchesNode(nodeToken('node-1'), null)).toBe(false);
    expect(callbackTokenMatchesNode(nodeToken('node-1'), undefined)).toBe(false);
  });
});

describe('callbackTokenMatchesWorkspace', () => {
  it('matches a workspace-scoped token bound to exactly that workspace', () => {
    expect(callbackTokenMatchesWorkspace(workspaceToken('ws-1'), 'ws-1')).toBe(true);
  });

  it('rejects a workspace-scoped token bound to a different workspace', () => {
    expect(callbackTokenMatchesWorkspace(workspaceToken('ws-999'), 'ws-1')).toBe(false);
  });

  it('rejects a node-scoped token', () => {
    expect(callbackTokenMatchesWorkspace(nodeToken('ws-1'), 'ws-1')).toBe(false);
  });

  it('is false for null/undefined target workspace (fails closed)', () => {
    expect(callbackTokenMatchesWorkspace(workspaceToken('ws-1'), null)).toBe(false);
    expect(callbackTokenMatchesWorkspace(workspaceToken('ws-1'), undefined)).toBe(false);
  });
});

describe('nodeStatusBlocksTokenRefresh', () => {
  it('blocks refresh for a deleted (deregistered) node', () => {
    expect(nodeStatusBlocksTokenRefresh('deleted')).toBe(true);
  });

  it('allows refresh for live/transient statuses', () => {
    for (const status of ['running', 'creating', 'pending', 'stopping', 'stopped', 'error']) {
      expect(nodeStatusBlocksTokenRefresh(status)).toBe(false);
    }
  });

  it('allows refresh for null/undefined status (does not block on missing data)', () => {
    expect(nodeStatusBlocksTokenRefresh(null)).toBe(false);
    expect(nodeStatusBlocksTokenRefresh(undefined)).toBe(false);
  });
});
