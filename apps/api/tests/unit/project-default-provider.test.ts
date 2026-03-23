/**
 * Structural verification tests for the project default provider feature.
 *
 * Validates the complete data path:
 *   1. Schema has the column
 *   2. Shared types include the field
 *   3. API PATCH route accepts, validates, and persists it
 *   4. Mapper returns it in responses
 *   5. Task submit reads project.defaultProvider and passes to TaskRunner
 *   6. Task runs route passes cloudProvider to TaskRunner
 *   7. TaskRunner DO config includes cloudProvider
 *   8. TaskRunner passes cloudProvider to createNodeRecord
 *   9. Settings UI renders provider selector and calls updateProject
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiSrc = (rel: string) =>
  readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');
const webSrc = (rel: string) =>
  readFileSync(resolve(process.cwd(), '../web/src', rel), 'utf8');
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
  const crud = apiSrc('routes/projects/crud.ts');

  it('imports CREDENTIAL_PROVIDERS for validation', () => {
    expect(crud).toContain('CREDENTIAL_PROVIDERS');
  });

  it('includes defaultProvider in the "at least one field" check', () => {
    expect(crud).toContain('body.defaultProvider === undefined');
  });

  it('validates defaultProvider against CREDENTIAL_PROVIDERS', () => {
    expect(crud).toContain('CREDENTIAL_PROVIDERS.includes(body.defaultProvider)');
  });

  it('persists defaultProvider in the update set', () => {
    expect(crud).toContain('defaultProvider: body.defaultProvider === undefined ? existing.defaultProvider');
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
    expect(submit).toContain('cloudProvider: provider');
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
  const runner = apiSrc('durable-objects/task-runner.ts');

  it('TaskRunConfig includes cloudProvider field', () => {
    expect(runner).toContain('cloudProvider: CredentialProvider | null');
  });

  it('passes cloudProvider to createNodeRecord', () => {
    expect(runner).toContain('cloudProvider: state.config.cloudProvider');
  });
});

describe('Project default provider — settings UI', () => {
  const settings = webSrc('pages/ProjectSettings.tsx');
  const drawer = webSrc('components/project/SettingsDrawer.tsx');

  it('ProjectSettings renders provider selector', () => {
    expect(settings).toContain('Default Cloud Provider');
    expect(settings).toContain('handleSaveProvider');
    expect(settings).toContain('defaultProvider');
  });

  it('ProjectSettings calls updateProject with defaultProvider', () => {
    expect(settings).toContain("updateProject(projectId, { defaultProvider:");
  });

  it('ProjectSettings only shows provider section when multiple providers configured', () => {
    expect(settings).toContain('configuredProviders.length > 1');
  });

  it('ProjectSettings loads user credentials to determine configured providers', () => {
    expect(settings).toContain('listCredentials');
    expect(settings).toContain('setConfiguredProviders');
  });

  it('SettingsDrawer renders provider selector', () => {
    expect(drawer).toContain('Default Cloud Provider');
    expect(drawer).toContain('handleSaveProvider');
    expect(drawer).toContain('defaultProvider');
  });

  it('SettingsDrawer only shows when multiple providers configured', () => {
    expect(drawer).toContain('configuredProviders.length > 1');
  });

  it('SettingsDrawer syncs defaultProvider from project context', () => {
    expect(drawer).toContain('project.defaultProvider');
    expect(drawer).toContain('setDefaultProvider');
  });
});
