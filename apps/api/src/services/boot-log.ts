import type { BootLogEntry } from '@simple-agent-manager/shared';

import type { WorkspaceBootLog } from '../durable-objects/workspace-boot-log';
import type { Env } from '../env';
import { storageCutover } from './reliability-storage';

type BootLogEnv = Pick<
  Env,
  | 'BOOT_LOG_TTL_SECONDS'
  | 'BOOT_LOG_MAX_ENTRIES'
  | 'WORKSPACE_BOOT_LOG'
  | 'BOOT_LOG_STORAGE_CUTOVER_AT'
>;

function durableLog(
  env: BootLogEnv | undefined,
  workspaceId: string
): DurableObjectStub<WorkspaceBootLog> | null {
  const cutover = storageCutover(env?.BOOT_LOG_STORAGE_CUTOVER_AT);
  if (cutover === null || Math.floor(Date.now() / 1000) < cutover) return null;
  if (!env?.WORKSPACE_BOOT_LOG)
    throw new Error('WORKSPACE_BOOT_LOG binding required after cutover');
  return env.WORKSPACE_BOOT_LOG.get(
    env.WORKSPACE_BOOT_LOG.idFromName(workspaceId)
  ) as DurableObjectStub<WorkspaceBootLog>;
}

const BOOT_LOG_PREFIX = 'bootlog:';
const DEFAULT_BOOT_LOG_TTL = 1800; // 30 minutes
const DEFAULT_BOOT_LOG_MAX_ENTRIES = 50;

function getBootLogTTL(env?: { BOOT_LOG_TTL_SECONDS?: string }): number {
  if (env?.BOOT_LOG_TTL_SECONDS) {
    const ttl = parseInt(env.BOOT_LOG_TTL_SECONDS, 10);
    if (!isNaN(ttl) && ttl > 0) return ttl;
  }
  return DEFAULT_BOOT_LOG_TTL;
}

function getBootLogMaxEntries(env?: { BOOT_LOG_MAX_ENTRIES?: string }): number {
  if (env?.BOOT_LOG_MAX_ENTRIES) {
    const max = parseInt(env.BOOT_LOG_MAX_ENTRIES, 10);
    if (!isNaN(max) && max > 0) return max;
  }
  return DEFAULT_BOOT_LOG_MAX_ENTRIES;
}

export async function getBootLogs(
  kv: KVNamespace,
  workspaceId: string,
  env?: BootLogEnv
): Promise<BootLogEntry[]> {
  const durable = durableLog(env, workspaceId);
  if (durable) {
    return durable.read(workspaceId, getBootLogMaxEntries(env));
  }
  const data = await kv.get<BootLogEntry[]>(`${BOOT_LOG_PREFIX}${workspaceId}`, { type: 'json' });
  return data || [];
}

export async function appendBootLog(
  kv: KVNamespace,
  workspaceId: string,
  entry: BootLogEntry,
  env?: BootLogEnv
): Promise<void> {
  const durable = durableLog(env, workspaceId);
  if (durable) return durable.append(entry, getBootLogTTL(env), getBootLogMaxEntries(env));
  const existing = await getBootLogs(kv, workspaceId);
  existing.push(entry);
  const maxEntries = getBootLogMaxEntries(env);
  const trimmed = existing.length > maxEntries ? existing.slice(-maxEntries) : existing;
  await kv.put(`${BOOT_LOG_PREFIX}${workspaceId}`, JSON.stringify(trimmed), {
    expirationTtl: getBootLogTTL(env),
  });
}

export async function writeBootLogs(
  kv: KVNamespace,
  workspaceId: string,
  logs: BootLogEntry[],
  env?: BootLogEnv
): Promise<void> {
  const durable = durableLog(env, workspaceId);
  if (durable) return durable.replace(logs, getBootLogTTL(env), getBootLogMaxEntries(env));
  await kv.put(`${BOOT_LOG_PREFIX}${workspaceId}`, JSON.stringify(logs), {
    expirationTtl: getBootLogTTL(env),
  });
}
