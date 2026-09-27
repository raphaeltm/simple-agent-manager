/**
 * Driving `ProjectData.alarm()` the way production reaches it, now that a tick runs only the
 * sections whose schedule is due (`alarm-sections.ts`).
 */
import { ACP_SESSION_DEFAULTS } from '@simple-agent-manager/shared';
import type { MockInstance } from 'vitest';

const HEARTBEAT_LEAD_MS = 50;

interface RecalculatingProjectData {
  recalculateAlarm(): Promise<void>;
}

/**
 * Heartbeats stop the way production sees it: the last one lands just inside the detection
 * window, the object recalculates its alarm as every heartbeat write does, and the deadline
 * passes before the alarm runs. Aging the row straight past the window is not equivalent: an
 * already-overdue heartbeat is scheduled a whole window out, so a gated tick would skip it.
 *
 * The recalculated alarm is deleted so the caller's own `alarm()` calls are the only ticks.
 */
export async function letHeartbeatDeadlinePass(
  instance: unknown,
  storage: DurableObjectStorage,
  acpSessionId: string,
  detectionWindowMs: number = ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS
): Promise<void> {
  storage.sql.exec(
    `UPDATE acp_sessions SET last_heartbeat_at = ? WHERE id = ?`,
    Date.now() - detectionWindowMs + HEARTBEAT_LEAD_MS,
    acpSessionId
  );
  await (instance as RecalculatingProjectData).recalculateAlarm();
  await storage.deleteAlarm();
  await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_LEAD_MS * 2));
}

export interface AlarmCompletion {
  projectId: string | null;
  mode: 'full' | 'gated';
  fullRunReason: string | null;
  ranSections: string[];
  skippedSections: string[];
  failedSections: string[];
  sections: Array<{ section: string; status: string; rowsRead: number }>;
}

/** Parsed `project_data.alarm.completed` logs captured by a `console.log` spy. */
export function alarmCompletions(
  logSpy: MockInstance<(...args: unknown[]) => void>,
  projectId?: string
): AlarmCompletion[] {
  const completions: AlarmCompletion[] = [];
  for (const call of logSpy.mock.calls) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(String(call[0])) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.event !== 'project_data.alarm.completed') continue;
    if (projectId !== undefined && entry.projectId !== projectId) continue;
    completions.push(entry as unknown as AlarmCompletion);
  }
  return completions;
}
