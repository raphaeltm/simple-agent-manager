import type { TaskStatusEvent } from '@simple-agent-manager/shared';

interface DebugReportData {
  taskId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
  nodeId?: string | null;
  projectId?: string | null;
  status?: string | null;
  executionStep?: string | null;
  classificationCode?: string | null;
  errorMessage?: string | null;
  events?: TaskStatusEvent[];
  maxEvents?: number;
}

export function buildDebugReport(data: DebugReportData): string {
  const max = data.maxEvents ?? 10;
  const lines: string[] = ['```', '## SAM Debug Report', ''];

  const ids: Array<[string, string | null | undefined]> = [
    ['Task', data.taskId],
    ['Session', data.sessionId],
    ['Workspace', data.workspaceId],
    ['Node', data.nodeId],
    ['Project', data.projectId],
  ];
  for (const [label, value] of ids) {
    if (value) lines.push(`${label}: ${value}`);
  }

  if (data.status) lines.push(`Status: ${data.status}`);
  if (data.executionStep) lines.push(`Step: ${data.executionStep}`);
  if (data.classificationCode) lines.push(`Classification: ${data.classificationCode}`);

  if (data.errorMessage) {
    lines.push('', `Error: ${data.errorMessage}`);
  }

  if (data.events && data.events.length > 0) {
    const recent = data.events.slice(-max);
    lines.push('', '### Status Events');
    for (const ev of recent) {
      const ts = new Date(ev.createdAt).toISOString();
      const transition = ev.fromStatus ? `${ev.fromStatus} → ${ev.toStatus}` : ev.toStatus;
      const actor = ev.actorType !== 'system' ? ` [${ev.actorType}]` : '';
      const reason = ev.reason ? ` — ${ev.reason}` : '';
      lines.push(`${ts} ${transition}${actor}${reason}`);
    }
  }

  lines.push('```');
  return lines.join('\n');
}
