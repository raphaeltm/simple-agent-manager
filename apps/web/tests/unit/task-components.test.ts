import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcRoot = join(__dirname, '../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf-8');
}

describe('TaskSubmitForm', () => {
  const source = readSource('components/task/TaskSubmitForm.tsx');

  it('exports TaskSubmitForm as named export', () => {
    expect(source).toContain('export const TaskSubmitForm');
  });

  it('exports TaskSubmitFormProps and TaskSubmitOptions interfaces', () => {
    expect(source).toContain('export interface TaskSubmitFormProps');
    expect(source).toContain('export interface TaskSubmitOptions');
  });

  it('accepts required props', () => {
    expect(source).toContain('projectId: string');
    expect(source).toContain('hasCloudCredentials: boolean');
    expect(source).toContain('onRunNow:');
    expect(source).toContain('onSaveToBacklog:');
  });

  it('uses SplitButton with Run Now as primary action', () => {
    expect(source).toContain('SplitButton');
    expect(source).toContain('primaryLabel="Run Now"');
  });

  it('has Save to Backlog as dropdown option', () => {
    expect(source).toContain('Save to Backlog');
    expect(source).toContain('handleSaveToBacklog');
  });

  it('validates empty title', () => {
    expect(source).toContain('Task description is required');
  });

  it('validates cloud credentials before Run Now', () => {
    expect(source).toContain('hasCloudCredentials');
    expect(source).toContain('Cloud credentials required');
    expect(source).toContain('Settings');
  });

  it('has expandable advanced options', () => {
    expect(source).toContain('showAdvanced');
    expect(source).toContain('advanced options');
  });

  it('advanced options include priority, VM size, and agent profile', () => {
    expect(source).toContain('Priority');
    expect(source).toContain('VM Size');
    expect(source).toContain('Agent Profile');
    expect(source).toContain('vmSize');
    expect(source).toContain('agentProfileId');
  });

  it('clears form on successful submission', () => {
    expect(source).toContain("setTitle('')");
    expect(source).toContain("setDescription('')");
  });

  it('disables form during submission', () => {
    expect(source).toContain('submitting');
    expect(source).toContain('disabled={submitting}');
  });

  it('shows error messages', () => {
    expect(source).toContain('setError');
    expect(source).toContain('text-danger');
  });

  it('submits on Enter key', () => {
    expect(source).toContain("e.key === 'Enter'");
    expect(source).toContain('handleRunNow');
  });
});

describe('ProjectChat chat-first submit integration', () => {
  const source = readSource('pages/ProjectChat.tsx');

  it('uses submitTask API for chat input', () => {
    expect(source).toContain('submitTask');
    expect(source).toContain("from '../lib/api'");
  });

  it('checks cloud credentials on mount', () => {
    expect(source).toContain('listCredentials');
    expect(source).toContain('hasCloudCredentials');
    expect(source).toContain("provider === 'hetzner'");
  });

  it('implements handleSubmit with message trimming', () => {
    expect(source).toContain('handleSubmit');
    expect(source).toContain('message.trim()');
    expect(source).toContain('submitTask(projectId');
  });

  it('validates cloud credentials before submit', () => {
    expect(source).toContain('hasCloudCredentials');
    expect(source).toContain('Cloud credentials required');
  });

  it('tracks provisioning state after submit', () => {
    expect(source).toContain('ProvisioningState');
    expect(source).toContain('setProvisioning');
    expect(source).toContain('result.taskId');
    expect(source).toContain('result.sessionId');
  });

  it('reloads sessions after submit', () => {
    expect(source).toContain('void loadSessions()');
  });
});

describe('API client: runProjectTask', () => {
  const source = readSource('lib/api.ts');

  it('exports runProjectTask function', () => {
    expect(source).toContain('export async function runProjectTask');
  });

  it('calls POST /api/projects/:id/tasks/:taskId/run', () => {
    expect(source).toContain('/tasks/${taskId}/run');
    expect(source).toContain("method: 'POST'");
  });

  it('imports RunTaskRequest and RunTaskResponse', () => {
    expect(source).toContain('RunTaskRequest');
    expect(source).toContain('RunTaskResponse');
  });
});
