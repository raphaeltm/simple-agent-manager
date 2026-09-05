import { log } from '../lib/logger';
import type { PendingWorkspaceDeletion } from './node-lifecycle-workspace-deletion-support';

export const WORKSPACE_DELETION_ENTRY_PREFIX = 'ws-delete:';
export const WORKSPACE_DELETION_DUE_INDEX_PREFIX = 'ws-delete-due:';
const WORKSPACE_DELETION_DUE_INDEX_BACKFILL_KEY = 'ws-delete-due-index-backfill:v1';
const WORKSPACE_DELETION_TIMESTAMP_WIDTH = String(Number.MAX_SAFE_INTEGER).length;

interface WorkspaceDeletionDueIndexBackfillState {
  cursor: string | null;
  done: boolean;
}

export function workspaceDeletionDueIndexKey(entry: PendingWorkspaceDeletion): string {
  const deleteAt = String(Math.max(0, Math.trunc(entry.deleteAt))).padStart(
    WORKSPACE_DELETION_TIMESTAMP_WIDTH,
    '0'
  );
  return `${WORKSPACE_DELETION_DUE_INDEX_PREFIX}${deleteAt}:${entry.workspaceId}`;
}

export function workspaceDeletionDueIndexTimestamp(key: string): number | null {
  const encoded = key.slice(WORKSPACE_DELETION_DUE_INDEX_PREFIX.length).split(':', 1)[0];
  if (!encoded) return null;
  const parsed = Number.parseInt(encoded, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isPendingWorkspaceDeletion(
  key: string,
  value: unknown
): value is PendingWorkspaceDeletion {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingWorkspaceDeletion>;
  return (
    typeof candidate.workspaceId === 'string' &&
    candidate.workspaceId.length > 0 &&
    key === `${WORKSPACE_DELETION_ENTRY_PREFIX}${candidate.workspaceId}` &&
    typeof candidate.userId === 'string' &&
    candidate.userId.length > 0 &&
    typeof candidate.deleteAt === 'number' &&
    Number.isSafeInteger(candidate.deleteAt) &&
    candidate.deleteAt >= 0
  );
}

export async function backfillWorkspaceDeletionDueIndexBatch(
  storage: DurableObjectStorage,
  batchSize: number
): Promise<void> {
  const outcome = await storage.transaction(async (transaction) => {
    const state = await transaction.get<WorkspaceDeletionDueIndexBackfillState>(
      WORKSPACE_DELETION_DUE_INDEX_BACKFILL_KEY
    );
    if (state?.done) return { malformedKeys: [] as string[] };
    const entries = await transaction.list<unknown>({
      prefix: WORKSPACE_DELETION_ENTRY_PREFIX,
      ...(state?.cursor ? { startAfter: state.cursor } : {}),
      limit: batchSize,
    });
    const malformedKeys: string[] = [];
    let cursor = state?.cursor ?? null;
    for (const [key, value] of entries) {
      cursor = key;
      if (!isPendingWorkspaceDeletion(key, value)) {
        malformedKeys.push(key);
        continue;
      }
      if (!value.deadLetteredAt) {
        await transaction.put(workspaceDeletionDueIndexKey(value), key);
      }
    }
    await transaction.put(WORKSPACE_DELETION_DUE_INDEX_BACKFILL_KEY, {
      cursor,
      done: entries.size < batchSize,
    } satisfies WorkspaceDeletionDueIndexBackfillState);
    return { malformedKeys };
  });
  for (const key of outcome.malformedKeys) {
    log.error('node_lifecycle.workspace_deletion_index_backfill_malformed', {
      entryKey: key,
      action: 'retained_without_index_for_operator_review',
    });
  }
}

export async function repairWorkspaceDeletionDueIndex(
  storage: DurableObjectStorage,
  indexKey: string,
  entryKey: string
): Promise<PendingWorkspaceDeletion | null> {
  return await storage.transaction(async (transaction) => {
    const current = await transaction.get<unknown>(entryKey);
    await transaction.delete(indexKey);
    if (!isPendingWorkspaceDeletion(entryKey, current) || current.deadLetteredAt) return null;
    await transaction.put(workspaceDeletionDueIndexKey(current), entryKey);
    return current;
  });
}

type WorkspaceDeletionIndexInspection =
  | { status: 'empty' }
  | { status: 'valid'; deleteAt: number }
  | { status: 'repaired' };

async function inspectFirstWorkspaceDeletionIndex(
  storage: DurableObjectStorage
): Promise<WorkspaceDeletionIndexInspection> {
  const indexed = await storage.list<string>({
    prefix: WORKSPACE_DELETION_DUE_INDEX_PREFIX,
    limit: 1,
  });
  const first = indexed.entries().next().value as [string, string] | undefined;
  if (!first) return { status: 'empty' };

  const [indexKey, entryKey] = first;
  const indexedDeleteAt = workspaceDeletionDueIndexTimestamp(indexKey);
  const entry = await storage.get<unknown>(entryKey);
  if (
    indexedDeleteAt !== null &&
    isPendingWorkspaceDeletion(entryKey, entry) &&
    !entry.deadLetteredAt &&
    workspaceDeletionDueIndexKey(entry) === indexKey
  ) {
    return { status: 'valid', deleteAt: indexedDeleteAt };
  }
  await repairWorkspaceDeletionDueIndex(storage, indexKey, entryKey);
  return { status: 'repaired' };
}

async function findEarliestWorkspaceDeletion(
  storage: DurableObjectStorage,
  warmAlarmTime: number | null,
  inspectionLimit: number
): Promise<{ earliest: number | null; inspected: number }> {
  let earliest = warmAlarmTime;
  let inspected = 0;
  while (inspected < inspectionLimit) {
    const inspection = await inspectFirstWorkspaceDeletionIndex(storage);
    if (inspection.status === 'empty') break;
    inspected += 1;
    if (inspection.status !== 'valid') continue;
    if (earliest === null || inspection.deleteAt < earliest) earliest = inspection.deleteAt;
    break;
  }
  return { earliest, inspected };
}

async function loadOrInitializeBackfillState(
  storage: DurableObjectStorage
): Promise<WorkspaceDeletionDueIndexBackfillState | undefined> {
  const backfill = await storage.get<WorkspaceDeletionDueIndexBackfillState>(
    WORKSPACE_DELETION_DUE_INDEX_BACKFILL_KEY
  );
  if (backfill) return backfill;

  const legacyEntries = await storage.list<unknown>({
    prefix: WORKSPACE_DELETION_ENTRY_PREFIX,
    limit: 1,
  });
  if (legacyEntries.size > 0) return undefined;
  const completed = { cursor: null, done: true } satisfies WorkspaceDeletionDueIndexBackfillState;
  await storage.put(WORKSPACE_DELETION_DUE_INDEX_BACKFILL_KEY, completed);
  return completed;
}

export async function recalculateWorkspaceDeletionAlarm(input: {
  storage: DurableObjectStorage;
  warmAlarmTime: number | null;
  inspectionLimit: number;
  boundedRescanDelayMs: number;
}): Promise<void> {
  const selection = await findEarliestWorkspaceDeletion(
    input.storage,
    input.warmAlarmTime,
    input.inspectionLimit
  );
  let { earliest } = selection;
  const backfill = await loadOrInitializeBackfillState(input.storage);
  if (!backfill?.done || selection.inspected === input.inspectionLimit) {
    const boundedRescanAt = Date.now() + input.boundedRescanDelayMs;
    if (earliest === null || boundedRescanAt < earliest) earliest = boundedRescanAt;
  }
  if (earliest !== null) await input.storage.setAlarm(earliest);
  else await input.storage.deleteAlarm();
}
