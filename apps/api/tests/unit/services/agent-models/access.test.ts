/**
 * `loadAgentModelCallContext` / `effectiveAgentModelAccess` against a real SQLite engine
 * (rule 28). Two project-boundary guards sit in this module:
 *
 *   1. `runtime.projectId !== token.projectId` — the workspace the caller named must belong to
 *      the project the caller's token is scoped to.
 *   2. `AND project_id = p.id` on the profile/skill subqueries — defense-in-depth scoping that
 *      only matters if (1), or the resolver it depends on, is ever weakened.
 *
 * Every attack case here has an owner-path control, and every guard was verified discriminating
 * by deleting it and confirming only the intended case goes red (see PR notes).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeAssets = vi.hoisted(() => ({
  resolveWorkspaceRuntimeAssetContext: vi.fn(),
}));

vi.mock('../../../../src/services/workspace-runtime-assets', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/services/workspace-runtime-assets')>();
  return {
    ...actual,
    resolveWorkspaceRuntimeAssetContext: runtimeAssets.resolveWorkspaceRuntimeAssetContext,
  };
});

import * as schema from '../../../../src/db/schema';
import type { Env } from '../../../../src/env';
import {
  effectiveAgentModelAccess,
  loadAgentModelCallContext,
} from '../../../../src/services/agent-models/access';
import { createAllSchemaTables, createSqliteD1 } from '../../../helpers/sqlite-d1';

const PROJECT = 'proj-1';
const OTHER_PROJECT = 'proj-2';
const USER = 'user-1';
const WORKSPACE = 'ws-1';
const SESSION = 'session-1';
const PROFILE = 'profile-1';
const SKILL = 'skill-1';
const FOREIGN_PROFILE = 'foreign-profile';

const GPT_OSS = '@cf/openai/gpt-oss-120b';
const CLEF_FLASH = '@cf/cloudflare/clef-flash';
const SECRET_FOREIGN_MODEL = '@cf/acme/foreign-only-model';

describe('loadAgentModelCallContext / effectiveAgentModelAccess', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(async () => {
    // By default, delegate to the real resolver so the control and the project-mismatch
    // attack both exercise production validation end to end. Individual tests override this
    // to simulate a resolver that already returned a cross-project id (defense-in-depth).
    const actual = await vi.importActual<
      typeof import('../../../../src/services/workspace-runtime-assets')
    >('../../../../src/services/workspace-runtime-assets');
    runtimeAssets.resolveWorkspaceRuntimeAssetContext.mockReset();
    runtimeAssets.resolveWorkspaceRuntimeAssetContext.mockImplementation(
      actual.resolveWorkspaceRuntimeAssetContext
    );

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
    for (const project of [PROJECT, OTHER_PROJECT]) {
      sqlite
        .prepare(
          "INSERT INTO projects (id, name, user_id, updated_at) VALUES (?, ?, ?, datetime('now'))"
        )
        .run(project, project, USER);
    }
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, user_id, node_id, status) VALUES (?, ?, ?, 'node-1', 'running')"
      )
      .run(WORKSPACE, PROJECT, USER);
    sqlite
      .prepare(
        "INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, agent_models_json, created_at, updated_at) VALUES (?, ?, ?, 'Builder', 'claude-code', 'auto', 0, ?, datetime('now'), datetime('now'))"
      )
      .run(PROFILE, PROJECT, USER, JSON.stringify([CLEF_FLASH]));
    sqlite
      .prepare(
        "INSERT INTO skills (id, project_id, user_id, name, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 'Review', 0, datetime('now'), datetime('now'))"
      )
      .run(SKILL, PROJECT, USER);
    sqlite
      .prepare(
        "INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, agent_models_json, created_at, updated_at) VALUES (?, ?, ?, 'Foreign', 'claude-code', 'auto', 0, ?, datetime('now'), datetime('now'))"
      )
      .run(FOREIGN_PROFILE, OTHER_PROJECT, USER, JSON.stringify([SECRET_FOREIGN_MODEL]));
    sqlite
      .prepare(
        'INSERT INTO agent_sessions (id, workspace_id, user_id, agent_profile_id, skill_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(SESSION, WORKSPACE, USER, PROFILE, SKILL);

    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  });

  describe('workspace/project binding', () => {
    it('owner-path control: resolves the real session profile and skill when projects match', async () => {
      const context = await loadAgentModelCallContext(env, {
        projectId: PROJECT,
        userId: USER,
        workspaceId: WORKSPACE,
        agentSessionId: SESSION,
      });
      expect(context.layers.profile).toEqual([CLEF_FLASH]);
      expect(context.agentProfileId).toBe(PROFILE);
      expect(context.skillId).toBe(SKILL);
    });

    it("attack: rejects when the named workspace's real project differs from the caller's token project", async () => {
      // The workspace itself belongs to OTHER_PROJECT; a token claiming PROJECT names it anyway.
      // No agentSessionId/profile/skill is involved here on purpose: this isolates access.ts's
      // own `runtime.projectId !== token.projectId` guard from `validateProfileId`'s separate
      // (and, for a profile-bearing session, earlier-firing) ownership check.
      sqlite
        .prepare('UPDATE workspaces SET project_id = ? WHERE id = ?')
        .run(OTHER_PROJECT, WORKSPACE);

      await expect(
        loadAgentModelCallContext(env, {
          projectId: PROJECT,
          userId: USER,
          workspaceId: WORKSPACE,
        })
      ).rejects.toThrow('This workspace does not belong to the calling project');
    });
  });

  describe('profile/skill subquery scoping (defense-in-depth against a resolver bug)', () => {
    it('owner-path control: a same-project profile returned by the resolver is applied normally', async () => {
      runtimeAssets.resolveWorkspaceRuntimeAssetContext.mockResolvedValue({
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        userId: USER,
        agentProfileId: PROFILE,
        skillId: null,
        source: 'agent-session',
      });

      const context = await loadAgentModelCallContext(env, {
        projectId: PROJECT,
        userId: USER,
        workspaceId: WORKSPACE,
      });
      expect(context.layers.profile).toEqual([CLEF_FLASH]);
    });

    it("attack: a resolver bug returning a foreign-project profile id must not leak that project's models", async () => {
      // Simulates `resolveWorkspaceRuntimeAssetContext` itself having a bug (or a future
      // caller that skips its validation) and handing back a profile id that is real, but
      // scoped to a DIFFERENT project than the one the token is calling on behalf of. The
      // workspace/project binding check above cannot catch this: it only compares the
      // *workspace's* project, not the profile's. The subquery's own `AND project_id = p.id`
      // is the only thing standing between this and reading another project's model access.
      runtimeAssets.resolveWorkspaceRuntimeAssetContext.mockResolvedValue({
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        userId: USER,
        agentProfileId: FOREIGN_PROFILE,
        skillId: null,
        source: 'agent-session',
      });

      const context = await loadAgentModelCallContext(env, {
        projectId: PROJECT,
        userId: USER,
        workspaceId: WORKSPACE,
      });

      // The foreign profile's models must never surface as this project's "profile" layer.
      expect(context.layers.profile).not.toEqual([SECRET_FOREIGN_MODEL]);
      expect(context.layers.profile).toBeNull();
    });
  });

  describe('effectiveAgentModelAccess', () => {
    it('keeps only catalog-known ids in modelIds and reports the rest as unavailable, preserving the source', () => {
      const result = effectiveAgentModelAccess(
        { skill: null, profile: null, project: [CLEF_FLASH, GPT_OSS, '@cf/acme/retired-model'] },
        [],
        new Set([CLEF_FLASH, GPT_OSS])
      );
      expect(result.source).toBe('project');
      expect(result.modelIds.sort()).toEqual([CLEF_FLASH, GPT_OSS].sort());
      expect(result.unavailableModelIds).toEqual(['@cf/acme/retired-model']);
    });

    it('falls through to the (already catalog-filtered) defaults when every layer is unset', () => {
      const result = effectiveAgentModelAccess(
        { skill: null, profile: null, project: null },
        [CLEF_FLASH],
        new Set([CLEF_FLASH])
      );
      expect(result).toEqual({
        source: 'default',
        modelIds: [CLEF_FLASH],
        unavailableModelIds: [],
      });
    });
  });
});
