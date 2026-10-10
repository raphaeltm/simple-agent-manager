/**
 * Shared harness for ProjectData storage-safety Worker tests that drive the real alarm over
 * simulated time.
 */
import { runInDurableObject } from 'cloudflare:test';
import { type MockInstance, vi } from 'vitest';

import type { Env as WorkerEnv } from '../../../src/env';
import type { ProjectDataTestDouble } from './expected-error-doubles';

/** Apply env overrides for the duration of `fn`; the DO reads the same env object. */
export async function withProjectDataStorageEnv<T>(
  env: WorkerEnv,
  overrides: Partial<Record<keyof WorkerEnv, string>>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = env as WorkerEnv & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

/**
 * Fire one real `alarm()` at `at` on a faked clock. The object's own `setAlarm` is suppressed and
 * any pending alarm deleted, so these explicit calls are the only ticks: a real timer firing
 * between them would add a storage pass at an uncontrolled time.
 */
export async function runAlarmAt(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  at: number
): Promise<void> {
  vi.setSystemTime(at);
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.deleteAlarm();
    const setAlarm = vi.spyOn(state.storage, 'setAlarm').mockResolvedValue(undefined);
    try {
      await instance.alarm();
    } finally {
      setAlarm.mockRestore();
      await state.storage.deleteAlarm();
    }
  });
}

/** `start`, `start + step`, ... up to and including `start + span`. */
export function tickTimes(start: number, stepMs: number, spanMs: number): number[] {
  const times: number[] = [];
  for (let offset = 0; offset <= spanMs; offset += stepMs) times.push(start + offset);
  return times;
}

export interface StorageAlarmCompletion {
  projectId: string | null;
  measured: boolean;
  failedSteps: string[];
  cleanupHealth: string | null;
  groupedFtsCleanup: { terminationReason: string; sessionsExamined: number } | null;
  eventLogCleanup: {
    rowsDeleted: { activityEvents: number; acpSessionEvents: number };
    terminationReason: string;
  } | null;
}

/**
 * Parsed `project_data.storage_alarm.completed` logs — the same event production reads to tell
 * whether a storage pass measured (`measured: true`) or only cleaned.
 */
export function storageAlarmCompletions(
  logSpy: MockInstance<(...args: unknown[]) => void>,
  projectId: string
): StorageAlarmCompletion[] {
  const completions: StorageAlarmCompletion[] = [];
  for (const call of logSpy.mock.calls) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(String(call[0])) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.event !== 'project_data.storage_alarm.completed') continue;
    if (entry.projectId !== projectId) continue;
    completions.push(entry as unknown as StorageAlarmCompletion);
  }
  return completions;
}
