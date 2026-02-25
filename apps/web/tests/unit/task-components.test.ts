import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('advanced options include priority, VM size, and agent hint', () => {
    expect(source).toContain('Priority');
    expect(source).toContain('VM Size');
    expect(source).toContain('Agent Hint');
    expect(source).toContain('vmSize');
    expect(source).toContain('agentProfileHint');
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
    expect(source).toContain('var(--sam-color-danger)');
  });

  it('submits on Enter key', () => {
    expect(source).toContain("e.key === 'Enter'");
    expect(source).toContain('handleRunNow');
  });
});

describe('TaskKanbanCard', () => {
  const source = readSource('components/task/TaskKanbanCard.tsx');

  it('exports TaskKanbanCard as named export', () => {
    expect(source).toContain('export const TaskKanbanCard');
  });

  it('exports TaskKanbanCardProps interface', () => {
    expect(source).toContain('export interface TaskKanbanCardProps');
  });

  it('accepts task and onClick props', () => {
    expect(source).toContain('task: Task');
    expect(source).toContain('onClick: (task: Task) => void');
  });

  it('displays task title', () => {
    expect(source).toContain('task.title');
  });

  it('uses StatusBadge for task status', () => {
    expect(source).toContain('StatusBadge');
    expect(source).toContain('task.status');
  });

  it('shows spinner for transient statuses', () => {
    expect(source).toContain('TRANSIENT_STATUSES');
    expect(source).toContain('isTransient');
    expect(source).toContain('Spinner');
  });

  it('shows workspace running indicator for active tasks', () => {
    expect(source).toContain('isActive');
    expect(source).toContain('hasWorkspace');
    expect(source).toContain('Running');
  });

  it('shows priority when non-zero', () => {
    expect(source).toContain('task.priority > 0');
    expect(source).toContain('P{task.priority}');
  });

  it('calls onClick with task on click', () => {
    expect(source).toContain('onClick={() => onClick(task)');
  });

  it('has hover styling', () => {
    expect(source).toContain('kanban-card:hover');
    expect(source).toContain('var(--sam-color-accent-primary)');
  });
});

describe('TaskKanbanBoard', () => {
  const source = readSource('components/task/TaskKanbanBoard.tsx');

  it('exports TaskKanbanBoard as named export', () => {
    expect(source).toContain('export const TaskKanbanBoard');
  });

  it('exports TaskKanbanBoardProps interface', () => {
    expect(source).toContain('export interface TaskKanbanBoardProps');
  });

  it('accepts projectId and onTaskClick props', () => {
    expect(source).toContain('projectId: string');
    expect(source).toContain('onTaskClick: (task: Task) => void');
  });

  it('defines primary columns for all 6 statuses', () => {
    expect(source).toContain("'draft'");
    expect(source).toContain("'ready'");
    expect(source).toContain("'in_progress'");
    expect(source).toContain("'completed'");
    expect(source).toContain("'failed'");
    expect(source).toContain("'cancelled'");
  });

  it('defines transient statuses that get dynamic columns', () => {
    expect(source).toContain('TRANSIENT_STATUSES');
    expect(source).toContain("'queued'");
    expect(source).toContain("'delegated'");
  });

  it('maps transient statuses to parent column', () => {
    expect(source).toContain('TRANSIENT_PARENT');
    expect(source).toContain("queued: 'in_progress'");
    expect(source).toContain("delegated: 'in_progress'");
  });

  it('fetches tasks from API', () => {
    expect(source).toContain('listProjectTasks(projectId');
  });

  it('groups tasks by status', () => {
    expect(source).toContain('tasksByStatus');
  });

  it('sorts tasks by priority within columns', () => {
    expect(source).toContain('b.priority - a.priority');
  });

  it('shows dynamic transient columns only when items exist', () => {
    expect(source).toContain('dynamicTransientColumns');
    expect(source).toContain('tasksByStatus[s]?.length');
  });

  it('renders column headers with labels and counts', () => {
    expect(source).toContain('COLUMN_LABELS');
    expect(source).toContain('columnTasks.length');
  });

  it('shows empty placeholder in empty columns', () => {
    expect(source).toContain('No tasks');
    expect(source).toContain('dashed');
  });

  it('uses TaskKanbanCard for each task', () => {
    expect(source).toContain('TaskKanbanCard');
    expect(source).toContain('onTaskClick');
  });

  it('renders grid layout with auto columns', () => {
    expect(source).toContain('gridTemplateColumns');
    expect(source).toContain('repeat(');
    expect(source).toContain('minmax(200px');
  });
});

describe('ProjectKanban page', () => {
  const source = readSource('pages/ProjectKanban.tsx');

  it('exports ProjectKanban function', () => {
    expect(source).toContain('export function ProjectKanban');
  });

  it('uses TaskKanbanBoard component', () => {
    expect(source).toContain('TaskKanbanBoard');
  });

  it('navigates to task detail on card click', () => {
    expect(source).toContain('handleTaskClick');
    expect(source).toContain('navigate(');
    expect(source).toContain('/tasks/');
  });

  it('uses project context', () => {
    expect(source).toContain('useProjectContext');
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

describe('Kanban routing integration', () => {
  const appSource = readSource('App.tsx');
  const projectSource = readSource('pages/Project.tsx');

  it('imports ProjectKanban in App.tsx', () => {
    expect(appSource).toContain("import { ProjectKanban } from './pages/ProjectKanban'");
  });

  it('registers kanban route', () => {
    expect(appSource).toContain('<Route path="kanban" element={<ProjectKanban />} />');
  });

  it('project page has no tab navigation (chat-first layout)', () => {
    // Tabs removed in 022 — kanban route exists but is not shown in project nav
    expect(projectSource).not.toContain("id: 'kanban'");
    expect(projectSource).not.toContain("id: 'tasks'");
    expect(projectSource).not.toContain("id: 'chat'");
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
