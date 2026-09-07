/**
 * Workspace Profile (Lightweight Mode) Tests
 *
 * Behavioral tests for the lightweight workspace profile feature:
 * - Contract schema validation (Zod safeParse)
 * - Shared constants and validation logic
 * - Workspace profile precedence resolution
 * - Profile-to-boolean conversion for VM agent
 */
import type { WorkspaceProfile } from '@simple-agent-manager/shared';
import {
  CreateWorkspaceAgentRequestSchema,
  DEFAULT_WORKSPACE_PROFILE,
  VALID_WORKSPACE_PROFILES,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

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
// Shared Constants & Validation Logic
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

describe('Workspace profile validation logic', () => {
  it('VALID_WORKSPACE_PROFILES accepts lightweight', () => {
    expect(VALID_WORKSPACE_PROFILES.includes('lightweight' as WorkspaceProfile)).toBe(true);
  });

  it('VALID_WORKSPACE_PROFILES accepts full', () => {
    expect(VALID_WORKSPACE_PROFILES.includes('full' as WorkspaceProfile)).toBe(true);
  });

  it('VALID_WORKSPACE_PROFILES rejects unknown values', () => {
    expect(VALID_WORKSPACE_PROFILES.includes('turbo' as WorkspaceProfile)).toBe(false);
    expect(VALID_WORKSPACE_PROFILES.includes('' as WorkspaceProfile)).toBe(false);
  });
});

// =============================================================================
// Workspace Profile Precedence Resolution (Behavioral)
//
// The precedence logic used in both submit.ts and run.ts is:
//   body.workspaceProfile ?? project.defaultWorkspaceProfile ?? DEFAULT_WORKSPACE_PROFILE
// This exercises the exact same ?? chain used in the route handlers.
// =============================================================================

describe('Workspace profile precedence resolution', () => {
  /**
   * Mirrors the precedence logic from apps/api/src/routes/tasks/submit.ts:169-171
   * and apps/api/src/routes/tasks/run.ts:161-163
   */
  function resolveWorkspaceProfile(
    explicitProfile: WorkspaceProfile | undefined,
    projectDefault: WorkspaceProfile | null,
  ): WorkspaceProfile {
    return explicitProfile
      ?? projectDefault
      ?? DEFAULT_WORKSPACE_PROFILE;
  }

  it('explicit lightweight overrides project default full', () => {
    expect(resolveWorkspaceProfile('lightweight', 'full')).toBe('lightweight');
  });

  it('explicit full overrides project default lightweight', () => {
    expect(resolveWorkspaceProfile('full', 'lightweight')).toBe('full');
  });

  it('project default lightweight applies when no explicit value', () => {
    expect(resolveWorkspaceProfile(undefined, 'lightweight')).toBe('lightweight');
  });

  it('project default full applies when no explicit value', () => {
    expect(resolveWorkspaceProfile(undefined, 'full')).toBe('full');
  });

  it('falls back to platform default (full) when both absent', () => {
    expect(resolveWorkspaceProfile(undefined, null)).toBe('full');
  });

  it('explicit value wins even when project default is null', () => {
    expect(resolveWorkspaceProfile('lightweight', null)).toBe('lightweight');
  });
});

// =============================================================================
// Profile-to-Boolean Conversion (Behavioral)
//
// The TaskRunner DO converts WorkspaceProfile to a boolean flag:
//   lightweight: state.config.workspaceProfile === 'lightweight'
// This exercises the exact same expression used in workspace-steps.ts:125
// =============================================================================

describe('Workspace profile to lightweight boolean conversion', () => {
  /**
   * Mirrors the conversion from apps/api/src/durable-objects/task-runner/workspace-steps.ts:125
   */
  function profileToLightweight(profile: WorkspaceProfile | null): boolean {
    return profile === 'lightweight';
  }

  it('converts lightweight profile to true', () => {
    expect(profileToLightweight('lightweight')).toBe(true);
  });

  it('converts full profile to false', () => {
    expect(profileToLightweight('full')).toBe(false);
  });

  it('converts null profile to false', () => {
    expect(profileToLightweight(null)).toBe(false);
  });
});
