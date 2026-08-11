/**
 * Structural verification tests for the project default provider feature,
 * plus behavioral coverage for the API PATCH route (item 3 below).
 *
 * Validates the complete data path:
 *   1. Schema has the column
 *   2. Shared types include the field
 *   3. API PATCH route accepts, validates, and persists it — behavioral
 *      (real Hono route + in-memory SQLite via createSqliteD1), not a
 *      source-text check. See .claude/rules/02-quality-gates.md: source-contract
 *      tests (readFileSync + toContain) prove code is present, not that it works,
 *      and broke here when prettier rewrapped the persisted-value line.
 *   4. Mapper returns it in responses
 *   5. Task submit reads project.defaultProvider and passes to TaskRunner
 *   6. Task runs route passes cloudProvider to TaskRunner
 *   7. TaskRunner DO config includes cloudProvider
 *   8. TaskRunner passes cloudProvider to createNodeRecord
 *   9. Settings UI renders provider selector and calls updateProject
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
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const apiSrc = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');
const webSrc = (rel: string) => readFileSync(resolve(process.cwd(), '../web/src', rel), 'utf8');
const sharedSrc = (rel: string) =>
  readFileSync(resolve(process.cwd(), '../../packages/shared/src', rel), 'utf8');

describe('Project default provider — schema', () => {
  const schema = apiSrc('db/schema.ts');

  it('projects table has defaultProvider column', () => {
    expect(schema).toContain("defaultProvider: text('default_provider')");
  });
});

describe('Project default provider — shared types', () => {
  const projectTypes = sharedSrc('types/project.ts');
  const taskTypes = sharedSrc('types/task.ts');

  it('Project interface includes defaultProvider field', () => {
    expect(projectTypes).toContain('defaultProvider?: CredentialProvider | null');
  });

  it('UpdateProjectRequest includes defaultProvider field', () => {
    const updateBlock = projectTypes.slice(
      projectTypes.indexOf('export interface UpdateProjectRequest'),
      projectTypes.indexOf('}', projectTypes.indexOf('export interface UpdateProjectRequest')) + 1
    );
    expect(updateBlock).toContain('defaultProvider?: CredentialProvider | null');
  });

  it('SubmitTaskRequest includes provider field', () => {
    const submitBlock = taskTypes.slice(
      taskTypes.indexOf('export interface SubmitTaskRequest'),
      taskTypes.indexOf('}', taskTypes.indexOf('export interface SubmitTaskRequest')) + 1
    );
    expect(submitBlock).toContain('provider?: CredentialProvider');
  });
});

describe('Project default provider — API PATCH route', () => {
  const OWNER = 'user-owner';
  const PROJECT_ID = 'project-default-provider';

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
  // is skipped — this describe block is scoped to defaultProvider
  // validation/persistence, not GitHub access verification.
  function seedProject(defaultProvider: string | null): void {
    const now = '2026-07-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, default_provider, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'main', 'github', 'active', ?, ?, ?, ?)`
      )
      .run(
        PROJECT_ID,
        OWNER,
        'Default Provider Project',
        'default provider project',
        'acme/repo',
        defaultProvider,
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

  function readStoredDefaultProvider(): string | null {
    const row = sqlite
      .prepare(`SELECT default_provider FROM projects WHERE id = ?`)
      .get(PROJECT_ID) as { default_provider: string | null } | undefined;
    return row?.default_provider ?? null;
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

  it('persists an explicit defaultProvider value — a single-field body also proves defaultProvider satisfies the "at least one field" requirement', async () => {
    seedProject(null);

    // The body contains ONLY defaultProvider. If defaultProvider were removed from
    // the route's allowed-field allowlist, this request would 400 with "At least
    // one field is required" instead of persisting — see the control test below.
    const response = await patchProject({ defaultProvider: 'scaleway' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultProvider: string | null };
    expect(body.defaultProvider).toBe('scaleway');
    expect(readStoredDefaultProvider()).toBe('scaleway');
  });

  it('leaves defaultProvider unchanged when the field is omitted (undefined) from the request', async () => {
    seedProject('hetzner');

    // defaultProvider is absent from the body entirely — only an unrelated field
    // is updated. Omitted must mean "leave alone", not "clear".
    const response = await patchProject({ description: 'updated description' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultProvider: string | null };
    expect(body.defaultProvider).toBe('hetzner');
    expect(readStoredDefaultProvider()).toBe('hetzner');
  });

  it('clears defaultProvider to null when the field is explicitly set to null', async () => {
    seedProject('hetzner');

    const response = await patchProject({ defaultProvider: null });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultProvider: string | null };
    expect(body.defaultProvider).toBeNull();
    expect(readStoredDefaultProvider()).toBeNull();
  });

  it('rejects an unrecognized defaultProvider value with 400 and never persists it', async () => {
    seedProject('hetzner');

    const response = await patchProject({ defaultProvider: 'not-a-real-provider' });

    expect(response.status).toBe(400);
    expect(readStoredDefaultProvider()).toBe('hetzner');
  });

  it('returns 400 when the request body has no recognized fields at all (control for the single-field test above)', async () => {
    seedProject('hetzner');

    const response = await patchProject({});

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/at least one field/i);
    expect(readStoredDefaultProvider()).toBe('hetzner');
  });
});

describe('Project default provider — mapper', () => {
  const mapper = apiSrc('lib/mappers.ts');

  it('toProjectResponse includes defaultProvider', () => {
    expect(mapper).toContain('defaultProvider:');
    expect(mapper).toContain('project.defaultProvider');
  });
});

describe('Project default provider — task submit', () => {
  const submit = apiSrc('routes/tasks/submit.ts');

  it('reads provider from body and project default with fallback', () => {
    expect(submit).toContain('body.provider');
    expect(submit).toContain('project.defaultProvider');
  });

  it('passes cloudProvider to startTaskRunnerDO', () => {
    expect(submit).toContain('cloudProvider: effectiveProvider');
  });

  it('validates provider against CREDENTIAL_PROVIDERS', () => {
    expect(submit).toContain('CREDENTIAL_PROVIDERS.includes(provider)');
  });
});

describe('Project default provider — task runs route', () => {
  const run = apiSrc('routes/tasks/run.ts');

  it('passes cloudProvider from project.defaultProvider to startTaskRunnerDO', () => {
    expect(run).toContain('cloudProvider:');
    expect(run).toContain('project.defaultProvider');
  });
});

describe('Project default provider — TaskRunner DO service', () => {
  const service = apiSrc('services/task-runner-do.ts');

  it('startTaskRunnerDO input accepts cloudProvider', () => {
    expect(service).toContain('cloudProvider?:');
  });

  it('passes cloudProvider into config', () => {
    expect(service).toContain('cloudProvider: input.cloudProvider');
  });
});

describe('Project default provider — TaskRunner DO', () => {
  const runner = [
    'index.ts',
    'types.ts',
    'node-steps.ts',
    'workspace-steps.ts',
    'agent-session-step.ts',
    'state-machine.ts',
    'helpers.ts',
  ]
    .map((f) => readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner', f), 'utf8'))
    .join('\n');

  it('TaskRunConfig includes cloudProvider field', () => {
    expect(runner).toContain('cloudProvider: CredentialProvider | null');
  });

  it('passes cloudProvider to createNodeRecord', () => {
    expect(runner).toContain('cloudProvider: state.config.cloudProvider');
  });
});

describe('Project default provider — settings UI', () => {
  const scaling = webSrc('components/ScalingSettings.tsx');

  it('ScalingSettings renders provider selector', () => {
    expect(scaling).toContain('Default Provider');
    expect(scaling).toContain('selectedProvider');
    expect(scaling).toContain('defaultProvider');
  });

  it('ScalingSettings calls updateProject with defaultProvider', () => {
    expect(scaling).toContain('defaultProvider: selectedProvider');
  });

  it('ScalingSettings loads user credentials to determine configured providers', () => {
    expect(scaling).toContain('listCredentials');
    expect(scaling).toContain('setConfiguredProviders');
  });
});
