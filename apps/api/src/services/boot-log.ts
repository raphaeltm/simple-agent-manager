import type { BootLogEntry } from '@simple-agent-manager/shared';

const BOOT_LOG_PREFIX = 'bootlog:';
const DEFAULT_BOOT_LOG_TTL = 1800; // 30 minutes
const DEFAULT_BOOT_LOG_MAX_ENTRIES = 200;

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

export async function getBootLogs(kv: KVNamespace, workspaceId: string): Promise<BootLogEntry[]> {
  const data = await kv.get<BootLogEntry[]>(`${BOOT_LOG_PREFIX}${workspaceId}`, { type: 'json' });
  return data || [];
}

export async function appendBootLog(
  kv: KVNamespace,
  workspaceId: string,
  entry: BootLogEntry,
  env?: { BOOT_LOG_TTL_SECONDS?: string; BOOT_LOG_MAX_ENTRIES?: string }
): Promise<void> {
  const existing = await getBootLogs(kv, workspaceId);
  existing.push(entry);
  const maxEntries = getBootLogMaxEntries(env);
  const trimmed = existing.length > maxEntries ? existing.slice(-maxEntries) : existing;
  await kv.put(
    `${BOOT_LOG_PREFIX}${workspaceId}`,
    JSON.stringify(trimmed),
    { expirationTtl: getBootLogTTL(env) }
  );
}

export async function writeBootLogs(
  kv: KVNamespace,
  workspaceId: string,
  logs: BootLogEntry[],
  env?: { BOOT_LOG_TTL_SECONDS?: string }
): Promise<void> {
  await kv.put(
    `${BOOT_LOG_PREFIX}${workspaceId}`,
    JSON.stringify(logs),
    { expirationTtl: getBootLogTTL(env) }
  );
}
