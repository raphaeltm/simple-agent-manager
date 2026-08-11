/**
 * Project agent defaults — unit + structural tests.
 *
 * Validates:
 *   1. resolveProjectAgentDefault() parses JSON and extracts per-agent-type overrides
 *   2. Schema + shared types have the new column / field
 *   3. API PATCH validates agent types + permission modes and persists the JSON —
 *      behavioral (real Hono route + in-memory SQLite via createSqliteD1), not a
 *      source-text check. See .claude/rules/02-quality-gates.md: source-contract
 *      tests (readFileSync + toContain) prove code is present, not that it works,
 *      and broke here when prettier rewrapped the update-set line in crud.ts.
 *   4. Task submit and MCP dispatch consult project.agentDefaults
 *   5. Agent-settings callback merges project → user fallback
 *   6. Project Settings UI renders the new section
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import type { AuthContext } from '../../src/middleware/auth';
import { AppError } from '../../src/middleware/error';
import { crudRoutes } from '../../src/routes/projects/crud';
import { resolveProjectAgentDefault } from '../../src/services/project-agent-defaults';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const apiSrc = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');
const webSrc = (rel: string) => readFileSync(resolve(process.cwd(), '../web/src', rel), 'utf8');
const sharedSrc = (rel: string) =>
  readFileSync(resolve(process.cwd(), '../../packages/shared/src', rel), 'utf8');

describe('resolveProjectAgentDefault', () => {
  it('returns nulls when rawAgentDefaults is null', () => {
    expect(resolveProjectAgentDefault(null, 'claude-code')).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('returns nulls when rawAgentDefaults is empty string', () => {
    expect(resolveProjectAgentDefault('', 'claude-code')).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('returns nulls when agentType is null', () => {
    const raw = JSON.stringify({ 'claude-code': { model: 'claude-opus-4-7' } });
    expect(resolveProjectAgentDefault(raw, null)).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('returns nulls when JSON is malformed', () => {
    expect(resolveProjectAgentDefault('{not json', 'claude-code')).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('returns nulls when JSON is an array (not an object)', () => {
    expect(resolveProjectAgentDefault('[]', 'claude-code')).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('returns nulls when the requested agent type is missing', () => {
    const raw = JSON.stringify({ 'openai-codex': { model: 'gpt-5-codex' } });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('extracts model when present', () => {
    const raw = JSON.stringify({ 'claude-code': { model: 'claude-opus-4-7' } });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: 'claude-opus-4-7',
      permissionMode: null,
    });
  });

  it('extracts permissionMode when present', () => {
    const raw = JSON.stringify({ 'claude-code': { permissionMode: 'bypassPermissions' } });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: null,
      permissionMode: 'bypassPermissions',
    });
  });

  it('extracts both model and permissionMode', () => {
    const raw = JSON.stringify({
      'claude-code': { model: 'claude-sonnet-4-5', permissionMode: 'acceptEdits' },
    });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: 'claude-sonnet-4-5',
      permissionMode: 'acceptEdits',
    });
  });

  it('ignores invalid permissionMode values (falls back to null)', () => {
    const raw = JSON.stringify({
      'claude-code': { model: 'claude-opus-4-7', permissionMode: 'notAValidMode' },
    });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: 'claude-opus-4-7',
      permissionMode: null,
    });
  });

  it('treats empty-string model as null', () => {
    const raw = JSON.stringify({ 'claude-code': { model: '' } });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: null,
      permissionMode: null,
    });
  });

  it('supports multiple agent types independently', () => {
    const raw = JSON.stringify({
      'claude-code': { model: 'claude-opus-4-7' },
      'openai-codex': { model: 'gpt-5-codex', permissionMode: 'plan' },
    });
    expect(resolveProjectAgentDefault(raw, 'claude-code')).toEqual({
      model: 'claude-opus-4-7',
      permissionMode: null,
    });
    expect(resolveProjectAgentDefault(raw, 'openai-codex')).toEqual({
      model: 'gpt-5-codex',
      permissionMode: 'plan',
    });
  });
});

describe('Project agent defaults — schema', () => {
  const schema = apiSrc('db/schema.ts');

  it('projects table has agent_defaults column', () => {
    expect(schema).toContain("agentDefaults: text('agent_defaults')");
  });
});

describe('Project agent defaults — migration', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'src/db/migrations/0042_project_agent_defaults.sql'),
    'utf8'
  );

  it('adds agent_defaults TEXT column', () => {
    expect(migration).toContain('ALTER TABLE projects ADD COLUMN agent_defaults TEXT');
  });
});

describe('Project agent defaults — shared types', () => {
  const projectTypes = sharedSrc('types/project.ts');
  const typesIndex = sharedSrc('types/index.ts');

  it('defines ProjectAgentDefaults type', () => {
    expect(projectTypes).toContain('export type ProjectAgentDefaults');
  });

  it('Project interface includes agentDefaults field', () => {
    expect(projectTypes).toMatch(/agentDefaults\?:\s*ProjectAgentDefaults\s*\|\s*null/);
  });

  it('UpdateProjectRequest includes agentDefaults field', () => {
    const updateBlock = projectTypes.slice(
      projectTypes.indexOf('export interface UpdateProjectRequest'),
      projectTypes.indexOf('}', projectTypes.indexOf('export interface UpdateProjectRequest')) + 1
    );
    expect(updateBlock).toMatch(/agentDefaults\?:\s*ProjectAgentDefaults\s*\|\s*null/);
  });

  it('types index re-exports ProjectAgentDefaults', () => {
    expect(typesIndex).toContain('ProjectAgentDefaults');
  });
});

describe('Project agent defaults — valibot schema', () => {
  const schema = apiSrc('schemas/projects.ts');

  it('imports VALID_PERMISSION_MODES', () => {
    expect(schema).toContain('VALID_PERMISSION_MODES');
  });

  it('defines AgentDefaultsSchema', () => {
    expect(schema).toContain('AgentDefaultsSchema');
  });

  it('UpdateProjectSchema has agentDefaults field', () => {
    expect(schema).toContain('agentDefaults:');
  });
});

describe('Project agent defaults — API PATCH route', () => {
  const OWNER = 'user-owner';
  const PROJECT_ID = 'project-agent-defaults';

  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function authContext(): AuthContext {
    return {
      user: {
        id: OWNER,
        email: 'owner@example.test',
        name: 'Project owner',
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: {
        id: 'session-owner',
        expiresAt: new Date('2026-08-10T00:00:00.000Z'),
      },
    };
  }

  // installation_id is left NULL so the PATCH handler's GitHub-repository-access
  // recheck (`existing.installationId && existing.repoProvider !== 'artifacts'`)
  // is skipped — this describe block is scoped to agentDefaults
  // validation/persistence, not GitHub access verification.
  function seedProject(agentDefaultsJson: string | null): void {
    const now = '2026-07-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, agent_defaults, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'main', 'github', 'active', ?, ?, ?, ?)`
      )
      .run(
        PROJECT_ID,
        OWNER,
        'Agent Defaults Project',
        'agent defaults project',
        'acme/repo',
        agentDefaultsJson,
        OWNER,
        now,
        now
      );
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, 'owner', 'active', ?, ?)`
      )
      .run(PROJECT_ID, OWNER, now, now);
  }

  function readStoredAgentDefaults(): string | null {
    const row = sqlite
      .prepare(`SELECT agent_defaults FROM projects WHERE id = ?`)
      .get(PROJECT_ID) as { agent_defaults: string | null } | undefined;
    return row?.agent_defaults ?? null;
  }

  async function patchProject(body: Record<string, unknown>): Promise<Response> {
    return app.request(
      `/api/projects/${PROJECT_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', authContext());
      await next();
    });
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/projects', crudRoutes);
  });

  afterEach(() => sqlite.close());

  it('persists agentDefaults as a JSON string — a single-field body also proves agentDefaults satisfies the "at least one field" requirement', async () => {
    seedProject(null);

    const payload = {
      'claude-code': { model: 'claude-opus-4-7', permissionMode: 'acceptEdits' },
      'openai-codex': { model: 'gpt-5-codex' },
    };

    // The body contains ONLY agentDefaults. If agentDefaults were removed from
    // the route's allowed-field allowlist, this request would 400 with "At least
    // one field is required" instead of persisting.
    const response = await patchProject({ agentDefaults: payload });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { agentDefaults: Record<string, unknown> | null };
    expect(body.agentDefaults).toEqual(payload);

    // The column must hold a JSON *string* that round-trips to the payload —
    // the behavioral mirror of the old "persists as JSON string" source check.
    const stored = readStoredAgentDefaults();
    expect(typeof stored).toBe('string');
    expect(JSON.parse(stored as string)).toEqual(payload);
  });

  it('leaves agentDefaults unchanged when the field is omitted (undefined) from the request', async () => {
    const seeded = JSON.stringify({ 'claude-code': { model: 'claude-opus-4-7' } });
    seedProject(seeded);

    // agentDefaults is absent from the body entirely — only an unrelated field
    // is updated. Omitted must mean "leave alone", not "clear".
    const response = await patchProject({ description: 'updated description' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { agentDefaults: Record<string, unknown> | null };
    expect(body.agentDefaults).toEqual({ 'claude-code': { model: 'claude-opus-4-7' } });
    expect(readStoredAgentDefaults()).toBe(seeded);
  });

  it('clears agentDefaults to SQL NULL (not the string "null") when explicitly set to null', async () => {
    seedProject(JSON.stringify({ 'claude-code': { model: 'claude-opus-4-7' } }));

    const response = await patchProject({ agentDefaults: null });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { agentDefaults: Record<string, unknown> | null };
    expect(body.agentDefaults).toBeNull();
    // Must be a real NULL. A naive `JSON.stringify(body.agentDefaults)` would
    // store the four-character string "null", which the response mapper hides
    // (it parses back to null) — only this DB read-back catches it.
    expect(readStoredAgentDefaults()).toBeNull();
  });

  it('rejects an unknown agent type with 400 and never persists it', async () => {
    const seeded = JSON.stringify({ 'claude-code': { model: 'claude-opus-4-7' } });
    seedProject(seeded);

    // The valibot schema accepts any string key (v.record), so unknown agent
    // types specifically exercise the handler's AGENT_CATALOG validation.
    const response = await patchProject({
      agentDefaults: { 'not-a-real-agent': { model: 'some-model' } },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/unknown agent type/i);
    expect(readStoredAgentDefaults()).toBe(seeded);
  });

  it('rejects an invalid permissionMode with 400 and never persists it', async () => {
    const seeded = JSON.stringify({ 'claude-code': { model: 'claude-opus-4-7' } });
    seedProject(seeded);

    // Two layers enforce this (the valibot picklist in jsonValidator fires
    // first; the handler's VALID_PERMISSION_MODES check is defense-in-depth),
    // so assert the black-box contract — 400 + unchanged row — rather than
    // coupling to which layer's message wins.
    const response = await patchProject({
      agentDefaults: { 'claude-code': { permissionMode: 'notAValidMode' } },
    });

    expect(response.status).toBe(400);
    expect(readStoredAgentDefaults()).toBe(seeded);
  });
});

describe('Project agent defaults — mapper', () => {
  const mapper = apiSrc('lib/mappers.ts');

  it('toProjectResponse JSON-parses agentDefaults', () => {
    expect(mapper).toContain('parseAgentDefaults');
    expect(mapper).toContain('agentDefaults: parseAgentDefaults(project.agentDefaults)');
  });
});

describe('Project agent defaults — task submit resolution', () => {
  const submit = apiSrc('routes/tasks/submit.ts');

  it('imports resolveProjectAgentDefault', () => {
    expect(submit).toContain('resolveProjectAgentDefault');
  });

  it('consults project.agentDefaults when profile has no model override', () => {
    expect(submit).toContain('resolveProjectAgentDefault(');
    expect(submit).toContain('project.agentDefaults');
  });
});

describe('Project agent defaults — MCP dispatch_task resolution', () => {
  const dispatch = apiSrc('routes/mcp/dispatch-tool.ts');

  it('imports resolveProjectAgentDefault', () => {
    expect(dispatch).toContain('resolveProjectAgentDefault');
  });

  it('consults project.agentDefaults when profile has no model override', () => {
    expect(dispatch).toContain('resolveProjectAgentDefault(project.agentDefaults');
  });
});

describe('Project agent defaults — agent-settings callback merges project → user', () => {
  const runtime = apiSrc('routes/workspaces/runtime.ts');

  it('fetches project.agentDefaults for the workspace project', () => {
    expect(runtime).toContain('projects.agentDefaults');
    expect(runtime).toContain('resolveProjectAgentDefault');
  });

  it('uses project override when present, else falls back to user settings', () => {
    expect(runtime).toMatch(/projectDefaults\.model\s*\?\?\s*userRow\?\.model/);
    expect(runtime).toMatch(/projectDefaults\.permissionMode\s*\?\?\s*userRow\?\.permissionMode/);
  });
});

describe('Project agent defaults — UI section (unified)', () => {
  // The dedicated ProjectAgentDefaultsSection component was merged into the
  // unified ProjectAgentCard + ProjectAgentsSection pair. Behavioral tests
  // live in apps/web/tests/unit/components/project-agents-section.test.tsx;
  // here we only assert the structural wiring to the new unified section.
  const card = webSrc('components/ProjectAgentCard.tsx');
  const section = webSrc('components/ProjectAgentsSection.tsx');
  const page = webSrc('pages/ProjectSettings.tsx');

  it('ProjectAgentCard imports ModelSelect for model combobox reuse', () => {
    expect(card).toContain("from './ModelSelect'");
  });

  it('ProjectAgentCard renders permission mode select with all valid modes', () => {
    expect(card).toContain('VALID_PERMISSION_MODES');
    expect(card).toContain('Inherit from user settings');
  });

  it('ProjectAgentsSection calls updateProject with agentDefaults payload', () => {
    expect(section).toContain('updateProject(projectId, { agentDefaults:');
  });

  it('ProjectSettings page renders ProjectAgentsSection', () => {
    expect(page).toContain('ProjectAgentsSection');
  });
});
