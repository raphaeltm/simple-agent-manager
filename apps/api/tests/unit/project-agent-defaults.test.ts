/**
 * Project agent defaults — unit + structural tests.
 *
 * Validates:
 *   1. resolveProjectAgentDefault() parses JSON and extracts per-agent-type overrides
 *   2. Schema + shared types have the new column / field
 *   3. API PATCH validates agent types + permission modes and persists the JSON
 *   4. Task submit and MCP dispatch consult project.agentDefaults
 *   5. Agent-settings callback merges project → user fallback
 *   6. Project Settings UI renders the new section
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveProjectAgentDefault } from '../../src/services/project-agent-defaults';

const apiSrc = (rel: string) =>
  readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');
const webSrc = (rel: string) =>
  readFileSync(resolve(process.cwd(), '../web/src', rel), 'utf8');
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
  const crud = apiSrc('routes/projects/crud.ts');

  it('imports AGENT_CATALOG and VALID_PERMISSION_MODES for validation', () => {
    expect(crud).toContain('AGENT_CATALOG');
    expect(crud).toContain('VALID_PERMISSION_MODES');
  });

  it('includes agentDefaults in the "at least one field" check', () => {
    expect(crud).toContain("'agentDefaults'");
  });

  it('validates agent types against AGENT_CATALOG', () => {
    expect(crud).toContain('unknown agent type');
  });

  it('validates permissionMode against VALID_PERMISSION_MODES', () => {
    expect(crud).toContain('permissionMode must be one of');
  });

  it('persists agentDefaults as JSON string in the update set', () => {
    expect(crud).toContain('agentDefaults: agentDefaultsColumn');
    expect(crud).toContain('JSON.stringify(body.agentDefaults)');
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

describe('Project agent defaults — UI section', () => {
  const component = webSrc('components/ProjectAgentDefaultsSection.tsx');
  const page = webSrc('pages/ProjectSettings.tsx');

  it('ProjectAgentDefaultsSection imports ModelSelect for model combobox reuse', () => {
    expect(component).toContain("from './ModelSelect'");
  });

  it('ProjectAgentDefaultsSection renders permission mode select with all valid modes', () => {
    expect(component).toContain('VALID_PERMISSION_MODES');
    expect(component).toContain('Inherit from user settings');
  });

  it('ProjectAgentDefaultsSection calls updateProject with agentDefaults payload', () => {
    expect(component).toContain('updateProject(projectId, { agentDefaults:');
  });

  it('ProjectSettings page renders ProjectAgentDefaultsSection', () => {
    expect(page).toContain('ProjectAgentDefaultsSection');
    expect(page).toContain('Project Agent Defaults');
  });
});
