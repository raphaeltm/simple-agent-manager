/**
 * Source contract tests for the POST /workspaces/:id/agent-credential-sync endpoint.
 *
 * Verifies the route handler implements required validation, auth, and credential
 * update logic by inspecting the source code for expected patterns.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('agent-credential-sync endpoint source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');

  it('defines the credential sync POST endpoint', () => {
    expect(file).toContain("workspacesRoutes.post('/:id/agent-credential-sync'");
  });

  it('uses callback JWT auth (not user auth)', () => {
    // The /agent-credential-sync path is in the callback auth bypass list
    expect(file).toContain("path.endsWith('/agent-credential-sync')");
    // The handler calls verifyWorkspaceCallbackAuth
    expect(file).toContain('verifyWorkspaceCallbackAuth(c, workspaceId)');
  });

  it('validates required body fields', () => {
    expect(file).toContain("'agentType, credentialKind, and credential are required'");
  });

  it('looks up workspace to get user ID', () => {
    expect(file).toContain('schema.workspaces.userId');
  });

  it('finds existing credential by user, agent type, and credential kind', () => {
    expect(file).toContain("eq(schema.credentials.credentialType, 'agent-api-key')");
    expect(file).toContain('eq(schema.credentials.agentType, body.agentType)');
    expect(file).toContain('eq(schema.credentials.credentialKind, body.credentialKind)');
  });

  it('handles missing credential gracefully', () => {
    expect(file).toContain('credential_not_found');
  });

  it('decrypts current credential for comparison', () => {
    expect(file).toContain('decrypt(');
    expect(file).toContain('existing.encryptedToken');
  });

  it('skips update when credential unchanged', () => {
    expect(file).toContain('currentCredential === body.credential');
    expect(file).toContain('updated: false');
  });

  it('re-encrypts with fresh IV on update', () => {
    expect(file).toContain('encrypt(body.credential, c.env.ENCRYPTION_KEY)');
  });

  it('updates the credential record in the database', () => {
    expect(file).toContain('db\n    .update(schema.credentials)');
    expect(file).toContain('encryptedToken: ciphertext');
  });

  it('returns success with updated flag', () => {
    expect(file).toContain('updated: true');
  });
});
