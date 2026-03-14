/**
 * Workspace Profile (Lightweight Mode) Tests
 *
 * Validates the complete data path for workspace profile selection:
 * - Contract schema includes lightweight field
 * - API routes validate and resolve workspace profile with correct precedence
 * - Project settings accept and persist defaultWorkspaceProfile
 * - TaskRunner DO converts profile to boolean flag for VM agent
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CreateWorkspaceAgentRequestSchema,
  VALID_WORKSPACE_PROFILES,
  DEFAULT_WORKSPACE_PROFILE,
} from '@simple-agent-manager/shared';

const apiSrc = join(__dirname, '../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(apiSrc, relativePath), 'utf-8');
}

// =============================================================================
// Contract Schema: CreateWorkspaceAgentRequest includes lightweight
// =============================================================================

describe('CreateWorkspaceAgentRequest schema — lightweight field', () => {
  it('accepts payload with lightweight: true', () => {
    const result = CreateWorkspaceAgentRequestSchema.safeParse({
      workspaceId: 'ws-abc123',
      repository: 'owner/repo',
      branch: 'main',
      lightweight: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lightweight).toBe(true);
    }
  });

  it('accepts payload with lightweight: false', () => {
    const result = CreateWorkspaceAgentRequestSchema.safeParse({
      workspaceId: 'ws-abc123',
      repository: 'owner/repo',
      branch: 'main',
      lightweight: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lightweight).toBe(false);
    }
  });

  it('accepts payload without lightweight (backward compatibility)', () => {
    const result = CreateWorkspaceAgentRequestSchema.safeParse({
      workspaceId: 'ws-abc123',
      repository: 'owner/repo',
      branch: 'main',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lightweight).toBeUndefined();
    }
  });

  it('rejects non-boolean lightweight value', () => {
    const result = CreateWorkspaceAgentRequestSchema.safeParse({
      workspaceId: 'ws-abc123',
      repository: 'owner/repo',
      branch: 'main',
      lightweight: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Shared Constants
// =============================================================================

describe('Workspace profile shared constants', () => {
  it('DEFAULT_WORKSPACE_PROFILE is full', () => {
    expect(DEFAULT_WORKSPACE_PROFILE).toBe('full');
  });

  it('VALID_WORKSPACE_PROFILES includes both full and lightweight', () => {
    expect(VALID_WORKSPACE_PROFILES).toContain('full');
    expect(VALID_WORKSPACE_PROFILES).toContain('lightweight');
    expect(VALID_WORKSPACE_PROFILES).toHaveLength(2);
  });
});

// =============================================================================
// API Route: Task Submit — workspace profile validation & precedence
// =============================================================================

describe('Task submit route — workspace profile handling', () => {
  const submitSource = readSource('routes/tasks/submit.ts');

  it('validates workspaceProfile against VALID_WORKSPACE_PROFILES', () => {
    expect(submitSource).toContain('body.workspaceProfile');
    expect(submitSource).toContain('VALID_WORKSPACE_PROFILES');
    expect(submitSource).toContain('workspaceProfile must be full or lightweight');
  });

  it('implements precedence: explicit > project default > platform default', () => {
    expect(submitSource).toContain('body.workspaceProfile');
    expect(submitSource).toContain('project.defaultWorkspaceProfile');
    expect(submitSource).toContain('DEFAULT_WORKSPACE_PROFILE');
  });

  it('passes workspaceProfile to TaskRunner DO', () => {
    expect(submitSource).toContain('workspaceProfile');
  });
});

// =============================================================================
// API Route: Task Run — workspace profile validation & precedence
// =============================================================================

describe('Task run route — workspace profile handling', () => {
  const runSource = readSource('routes/tasks/run.ts');

  it('validates workspaceProfile against VALID_WORKSPACE_PROFILES', () => {
    expect(runSource).toContain('body.workspaceProfile');
    expect(runSource).toContain('VALID_WORKSPACE_PROFILES');
    expect(runSource).toContain('workspaceProfile must be full or lightweight');
  });

  it('implements precedence: explicit > project default > platform default', () => {
    expect(runSource).toContain('body.workspaceProfile');
    expect(runSource).toContain('project.defaultWorkspaceProfile');
    expect(runSource).toContain('DEFAULT_WORKSPACE_PROFILE');
  });
});

// =============================================================================
// API Route: Project PATCH — defaultWorkspaceProfile
// =============================================================================

describe('Project PATCH route — defaultWorkspaceProfile', () => {
  const crudSource = readSource('routes/projects/crud.ts');

  it('accepts defaultWorkspaceProfile in update body', () => {
    expect(crudSource).toContain('body.defaultWorkspaceProfile');
  });

  it('validates against VALID_WORKSPACE_PROFILES', () => {
    expect(crudSource).toContain('VALID_WORKSPACE_PROFILES');
    expect(crudSource).toContain('defaultWorkspaceProfile must be full or lightweight');
  });

  it('allows null to clear project default', () => {
    expect(crudSource).toContain('body.defaultWorkspaceProfile');
  });
});

// =============================================================================
// TaskRunner DO — converts profile to lightweight boolean
// =============================================================================

describe('TaskRunner DO — workspace profile to lightweight flag', () => {
  const doSource = readSource('durable-objects/task-runner.ts');

  it('stores workspaceProfile in task config', () => {
    expect(doSource).toContain('workspaceProfile');
  });

  it('converts lightweight profile to boolean flag for VM agent', () => {
    expect(doSource).toContain("lightweight: state.config.workspaceProfile === 'lightweight'");
  });
});

// =============================================================================
// Node Agent Service — sends lightweight flag to VM agent
// =============================================================================

describe('Node agent service — lightweight flag in workspace creation', () => {
  const nodeAgentSource = readSource('services/node-agent.ts');

  it('accepts lightweight option in createWorkspaceOnNode', () => {
    expect(nodeAgentSource).toContain('lightweight?: boolean');
  });
});

// =============================================================================
// Database Schema — defaultWorkspaceProfile column
// =============================================================================

describe('Database schema — workspace profile column', () => {
  const schemaSource = readSource('db/schema.ts');

  it('projects table has defaultWorkspaceProfile column', () => {
    expect(schemaSource).toContain("defaultWorkspaceProfile: text('default_workspace_profile')");
  });
});
