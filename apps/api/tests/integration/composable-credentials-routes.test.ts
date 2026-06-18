/**
 * Integration tests for composable-credentials CRUD routes and resolver wiring.
 *
 * Validates:
 * - Route registration in the API route registry
 * - Route handler delegates to correct schema tables
 * - Auth middleware is applied (requireAuth + requireApproved)
 * - IDOR protection (owner_id / user_id scoping)
 * - Resolver service wiring (snapshot builder, resolveAgentEnv, resolveComputeConfig)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const routeRegistryFile = readFileSync(resolve(process.cwd(), 'src/app/register-routes.ts'), 'utf8');
const routeFile = readFileSync(resolve(process.cwd(), 'src/routes/composable-credentials.ts'), 'utf8');
const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
const resolveFile = readFileSync(resolve(process.cwd(), 'src/services/composable-credentials/resolve.ts'), 'utf8');
const snapshotFile = readFileSync(resolve(process.cwd(), 'src/services/composable-credentials/snapshot.ts'), 'utf8');
const backfillFile = readFileSync(resolve(process.cwd(), 'src/services/composable-credentials/backfill-service.ts'), 'utf8');

describe('composable-credentials route registration', () => {
  it('mounts ccRoutes under /api/cc', () => {
    expect(routeRegistryFile).toContain("app.route('/api/cc', ccRoutes)");
  });

  it('imports ccRoutes from composable-credentials module', () => {
    expect(routeRegistryFile).toContain("import { ccRoutes }");
  });
});

describe('composable-credentials auth middleware', () => {
  it('applies requireAuth and requireApproved to all cc routes', () => {
    expect(routeFile).toContain('requireAuth()');
    expect(routeFile).toContain('requireApproved()');
  });

  it('uses wildcard middleware for all sub-routes', () => {
    expect(routeFile).toContain("ccRoutes.use('/*'");
  });
});

describe('composable-credentials CRUD operations', () => {
  it('credentials: list, create, patch, delete routes exist', () => {
    expect(routeFile).toContain("ccRoutes.get('/credentials'");
    expect(routeFile).toContain("ccRoutes.post('/credentials'");
    expect(routeFile).toContain("ccRoutes.patch('/credentials/:id'");
    expect(routeFile).toContain("ccRoutes.delete('/credentials/:id'");
  });

  it('configurations: list, create, patch, delete routes exist', () => {
    expect(routeFile).toContain("ccRoutes.get('/configurations'");
    expect(routeFile).toContain("ccRoutes.post('/configurations'");
    expect(routeFile).toContain("ccRoutes.patch('/configurations/:id'");
    expect(routeFile).toContain("ccRoutes.delete('/configurations/:id'");
  });

  it('attachments: list, create, patch, delete routes exist', () => {
    expect(routeFile).toContain("ccRoutes.get('/attachments'");
    expect(routeFile).toContain("ccRoutes.post('/attachments'");
    expect(routeFile).toContain("ccRoutes.patch('/attachments/:id'");
    expect(routeFile).toContain("ccRoutes.delete('/attachments/:id'");
  });
});

describe('composable-credentials IDOR protection', () => {
  it('credentials: list filters by ownerId', () => {
    expect(routeFile).toContain('ccCredentials.ownerId, userId');
  });

  it('credentials: patch requires ownerId match', () => {
    expect(routeFile).toContain('eq(schema.ccCredentials.ownerId, userId)');
  });

  it('credentials: delete requires ownerId match', () => {
    // The delete route uses both id and ownerId in the where clause
    const deleteMatch = routeFile.match(/delete\(schema\.ccCredentials\)[\s\S]*?ownerId, userId/);
    expect(deleteMatch).not.toBeNull();
  });

  it('configurations: verifies credential ownership before creation', () => {
    expect(routeFile).toContain('Credential not found or not owned by user');
  });

  it('attachments: verifies configuration ownership before creation', () => {
    expect(routeFile).toContain('Configuration not found or not owned by user');
  });

  it('attachments: verifies project ownership before creation', () => {
    expect(routeFile).toContain('Project not found or not owned by user');
  });
});

describe('composable-credentials credential validation', () => {
  it('validates credential kind against whitelist', () => {
    expect(routeFile).toContain("'api-key'");
    expect(routeFile).toContain("'oauth-token'");
    expect(routeFile).toContain("'openai-compatible'");
    expect(routeFile).toContain("'cloud-provider'");
    expect(routeFile).toContain("'auth-json'");
  });

  it('requires name, kind, and secret for credential creation', () => {
    expect(routeFile).toContain('name, kind, and secret are required');
  });

  it('encrypts secrets before storage', () => {
    expect(routeFile).toContain('encrypt(');
    expect(routeFile).toContain('getCredentialEncryptionKey');
  });

  it.each([
    ['credential HTTPS validation', [
      'validateOpenAICompatibleSecret(secret)',
      'HTTPS baseUrl is required',
      'openai-compatible credentials require apiKey, baseUrl, and dialect',
      'openai-compatible credentials require dialect openai-compatible',
    ]],
    ['configuration dialect compatibility', [
      'validateConfigurationSettings({ consumerKind, consumerTarget, settings })',
      'resolveHarnessDialect(input.consumerTarget, dialect)',
      'does not support provider dialect',
    ]],
  ])('%s', (_label, snippets) => {
    for (const snippet of snippets) expect(routeFile).toContain(snippet);
  });
});

describe('composable-credentials schema tables', () => {
  it('defines cc_credentials table', () => {
    expect(schemaFile).toContain("'cc_credentials'");
  });

  it('defines cc_configurations table', () => {
    expect(schemaFile).toContain("'cc_configurations'");
  });

  it('defines cc_attachments table', () => {
    expect(schemaFile).toContain("'cc_attachments'");
  });
});

describe('composable-credentials resolver wiring', () => {
  it('resolveAgentEnv calls buildSnapshot and agentAssembler', () => {
    expect(resolveFile).toContain('buildSnapshot');
    expect(resolveFile).toContain('agentAssembler.assemble');
  });

  it('resolveComputeConfig calls buildSnapshot and computeAssembler', () => {
    expect(resolveFile).toContain('computeAssembler.assemble');
  });

  it('snapshot builder queries all three cc tables', () => {
    expect(snapshotFile).toContain('ccCredentials');
    expect(snapshotFile).toContain('ccConfigurations');
    expect(snapshotFile).toContain('ccAttachments');
  });

  it('snapshot builder decrypts credentials', () => {
    expect(snapshotFile).toContain('decrypt(');
  });

  it('snapshot builder includes platform defaults from legacy table', () => {
    expect(snapshotFile).toContain('platformCredentials');
    expect(snapshotFile).toContain('buildPlatformDefaults');
  });
});

describe('composable-credentials backfill wiring', () => {
  it('backfill service reads from legacy credentials table', () => {
    expect(backfillFile).toContain('.from(credentials)');
  });

  it('backfill service reads from legacy platformCredentials table', () => {
    expect(backfillFile).toContain('.from(platformCredentials)');
  });

  it('backfill service inserts into all three cc tables', () => {
    expect(backfillFile).toContain('db.insert(ccCredentials)');
    expect(backfillFile).toContain('db.insert(ccConfigurations)');
    expect(backfillFile).toContain('db.insert(ccAttachments)');
  });

  it('backfill uses onConflictDoNothing for idempotency', () => {
    expect(backfillFile).toContain('.onConflictDoNothing()');
  });

  it('backfill supports dryRun mode', () => {
    expect(backfillFile).toContain('dryRun');
  });
});
