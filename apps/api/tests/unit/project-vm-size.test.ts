import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiSrc = join(__dirname, '../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(apiSrc, relativePath), 'utf-8');
}

describe('Project default VM size — API endpoint', () => {
  const projectsSource = readSource('routes/projects.ts');

  it('PATCH endpoint accepts defaultVmSize field', () => {
    expect(projectsSource).toContain('body.defaultVmSize');
  });

  it('validates defaultVmSize as small, medium, or large', () => {
    expect(projectsSource).toContain("defaultVmSize must be small, medium, or large");
  });

  it('allows null defaultVmSize to clear to system default', () => {
    expect(projectsSource).toContain('body.defaultVmSize ?? null');
  });

  it('GET project returns defaultVmSize', () => {
    expect(projectsSource).toContain('defaultVmSize:');
    expect(projectsSource).toContain('project.defaultVmSize');
  });
});

describe('Project default VM size — task runner', () => {
  const taskRunnerSource = readSource('services/task-runner.ts');

  it('imports DEFAULT_VM_SIZE from shared constants', () => {
    expect(taskRunnerSource).toContain('DEFAULT_VM_SIZE');
    expect(taskRunnerSource).toContain("from '@simple-agent-manager/shared'");
  });

  it('implements VM size precedence: explicit > project default > platform default', () => {
    // The three-level fallback chain
    expect(taskRunnerSource).toContain('input.vmSize');
    expect(taskRunnerSource).toContain('project.defaultVmSize');
    expect(taskRunnerSource).toContain('DEFAULT_VM_SIZE');
  });

  it('uses nullish coalescing for the fallback chain', () => {
    // Should have the pattern: input.vmSize ?? project.defaultVmSize ?? DEFAULT_VM_SIZE
    expect(taskRunnerSource).toContain('input.vmSize\n    ?? (project.defaultVmSize');
    expect(taskRunnerSource).toContain('?? DEFAULT_VM_SIZE');
  });

  it('casts project.defaultVmSize to VMSize | null', () => {
    expect(taskRunnerSource).toContain('as VMSize | null');
  });

  it('reads project data before determining VM size', () => {
    // project is loaded from DB
    const projectLoadIdx = taskRunnerSource.indexOf('schema.projects.id, input.projectId');
    const vmSizeIdx = taskRunnerSource.indexOf('project.defaultVmSize');
    expect(projectLoadIdx).toBeGreaterThan(-1);
    expect(vmSizeIdx).toBeGreaterThan(-1);
    expect(projectLoadIdx).toBeLessThan(vmSizeIdx);
  });
});

describe('Project default VM size — schema', () => {
  const schemaSource = readSource('db/schema.ts');

  it('projects table has defaultVmSize column', () => {
    expect(schemaSource).toContain("defaultVmSize: text('default_vm_size')");
  });
});

describe('Project default VM size — settings UI', () => {
  const webSrc = join(__dirname, '../../../web/src');
  const settingsSource = readFileSync(join(webSrc, 'pages/ProjectSettings.tsx'), 'utf-8');

  it('renders VM size selector with small, medium, large options', () => {
    expect(settingsSource).toContain("value: 'small'");
    expect(settingsSource).toContain("value: 'medium'");
    expect(settingsSource).toContain("value: 'large'");
  });

  it('shows size descriptions', () => {
    expect(settingsSource).toContain('2 vCPUs');
    expect(settingsSource).toContain('4 vCPUs');
    expect(settingsSource).toContain('8 vCPUs');
  });

  it('saves VM size on selection', () => {
    expect(settingsSource).toContain('handleSaveVmSize');
    expect(settingsSource).toContain('updateProject(projectId');
    expect(settingsSource).toContain('defaultVmSize');
  });

  it('allows clearing to platform default', () => {
    expect(settingsSource).toContain('size === defaultVmSize ? null : size');
    expect(settingsSource).toContain('platform default');
  });

  it('syncs state from project context', () => {
    expect(settingsSource).toContain('project?.defaultVmSize');
    expect(settingsSource).toContain('useEffect');
  });
});
