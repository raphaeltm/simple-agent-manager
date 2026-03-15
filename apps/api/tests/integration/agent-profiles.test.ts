/**
 * Integration tests for agent profiles — verifying cross-module wiring.
 *
 * Validates that the service, routes, schema, and shared types are properly
 * connected. Service-level behavior is covered by unit tests in
 * tests/unit/services/agent-profiles.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
const routeFile = readFileSync(resolve(process.cwd(), 'src/routes/agent-profiles.ts'), 'utf8');
const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/agent-profiles.ts'), 'utf8');
const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');

describe('agent profiles integration wiring', () => {
  it('registers agent-profiles route under /api/projects/:projectId/', () => {
    expect(indexFile).toContain(
      "app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes)"
    );
  });

  it('imports agent profile routes in index', () => {
    expect(indexFile).toContain("import { agentProfileRoutes }");
  });

  it('route handler delegates all operations to the service layer', () => {
    expect(routeFile).toContain('agentProfileService.listProfiles');
    expect(routeFile).toContain('agentProfileService.createProfile');
    expect(routeFile).toContain('agentProfileService.getProfile');
    expect(routeFile).toContain('agentProfileService.updateProfile');
    expect(routeFile).toContain('agentProfileService.deleteProfile');
    expect(routeFile).toContain('agentProfileService.resolveAgentProfile');
  });

  it('service uses agentProfiles schema table for all queries', () => {
    expect(serviceFile).toContain('schema.agentProfiles');
  });

  it('schema defines agentProfiles table with required columns', () => {
    expect(schemaFile).toContain("'agent_profiles'");
    expect(schemaFile).toContain("text('project_id')");
    expect(schemaFile).toContain("text('user_id')");
    expect(schemaFile).toContain("text('agent_type')");
    expect(schemaFile).toContain("text('system_prompt_append')");
    expect(schemaFile).toContain("integer('is_builtin')");
    expect(schemaFile).toContain("text('vm_size_override')");
  });

  it('service guards built-in profiles against modification and deletion', () => {
    expect(serviceFile).toContain('Built-in profiles cannot be modified');
    expect(serviceFile).toContain('Built-in profiles cannot be deleted');
  });

  it('Env interface includes configurable built-in profile model env vars', () => {
    expect(indexFile).toContain('BUILTIN_PROFILE_SONNET_MODEL');
    expect(indexFile).toContain('BUILTIN_PROFILE_OPUS_MODEL');
  });

  it('service uses env vars for built-in profile model configuration', () => {
    expect(serviceFile).toContain('env.BUILTIN_PROFILE_SONNET_MODEL');
    expect(serviceFile).toContain('env.BUILTIN_PROFILE_OPUS_MODEL');
  });

  it('resolve endpoint passes env to service for resolution', () => {
    expect(routeFile).toContain('c.env');
  });
});
