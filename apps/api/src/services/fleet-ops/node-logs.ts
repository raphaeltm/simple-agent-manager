/**
 * `ops_node_logs`: a filtered, size-capped read of a node's logs through the VM agent's
 * `/logs` endpoint (`packages/vm-agent/internal/server/logs.go`).
 *
 * The agent applies `search` only within the page it has already read, so a narrow `contains`
 * over a small page would miss most matches. With `contains` set, the API asks the agent for a
 * full scan page (`VM_LOG_SCAN_PAGE`), re-applies the filter itself (older agents may ignore
 * `search`), and returns at most `maxLines` lines and `maxBytes` bytes. `nextCursor` reads
 * further back.
 */
import type { Env } from '../../env';
import { untrustedTextBlock } from '../../operations/untrusted-text';
import { getNodeLogsFromNode } from '../node-agent-diagnostics';
import { type NodeAccess, runNodeDiagnostic } from '../node-diagnostics-access';

/** The VM agent's own maximum page (`logreader.MaxLimit` default). */
export const VM_LOG_SCAN_PAGE = 1000;

export const NODE_LOG_SOURCES = ['all', 'agent', 'cloud-init', 'docker', 'systemd'] as const;
export const NODE_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export interface NodeLogQuery {
  readonly source?: (typeof NODE_LOG_SOURCES)[number];
  readonly level?: (typeof NODE_LOG_LEVELS)[number];
  readonly container?: string;
  readonly since?: string;
  readonly until?: string;
  readonly contains?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
}

function parseEntries(payload: unknown): {
  entries: LogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const raw = Array.isArray(record.entries) ? record.entries : [];
  const entries = raw.flatMap((item): LogEntry[] => {
    if (typeof item !== 'object' || item === null) return [];
    const e = item as Record<string, unknown>;
    return [
      {
        timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
        level: typeof e.level === 'string' ? e.level : '',
        source: typeof e.source === 'string' ? e.source : '',
        message: typeof e.message === 'string' ? e.message : String(e.message ?? ''),
      },
    ];
  });
  return {
    entries,
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null,
    hasMore: record.hasMore === true,
  };
}

export async function readNodeLogs(
  env: Env,
  node: { id: string; status: string },
  access: NodeAccess,
  query: NodeLogQuery,
  caps: { maxLines: number; maxBytes: number }
) {
  const lineCap = Math.max(1, Math.min(query.limit ?? caps.maxLines, caps.maxLines));
  const contains = query.contains?.trim() || '';
  const params = new URLSearchParams();
  params.set('source', query.source ?? 'all');
  params.set('level', query.level ?? 'debug');
  params.set('limit', String(contains ? VM_LOG_SCAN_PAGE : lineCap));
  if (query.container) params.set('container', query.container);
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.cursor) params.set('cursor', query.cursor);
  if (contains) params.set('search', contains);

  const outcome = await runNodeDiagnostic(node, access, (nodeId, userId) =>
    getNodeLogsFromNode(nodeId, env, userId, params.toString())
  );
  if (outcome.status !== 'ok') return outcome;

  const page = parseEntries(outcome.value);
  const needle = contains.toLowerCase();
  const matched = needle
    ? page.entries.filter((e) => e.message.toLowerCase().includes(needle))
    : page.entries;

  const lines: string[] = [];
  let bytes = 0;
  let truncatedByBytes = false;
  for (const entry of matched.slice(0, lineCap)) {
    const line = `${entry.timestamp} ${entry.level} ${entry.source} ${entry.message}`;
    const size = new TextEncoder().encode(line).byteLength + 1;
    if (bytes + size > caps.maxBytes) {
      truncatedByBytes = true;
      break;
    }
    lines.push(line);
    bytes += size;
  }

  return {
    status: 'ok' as const,
    filter: { ...query, contains: contains || undefined, limit: lineCap },
    scannedEntries: page.entries.length,
    matchedEntries: matched.length,
    returnedLines: lines.length,
    returnedBytes: bytes,
    truncated: truncatedByBytes || matched.length > lines.length,
    truncatedByBytes,
    nextCursor: page.nextCursor,
    moreOnNode: page.hasMore,
    log: untrustedTextBlock({ kind: 'node log', text: lines.join('\n'), maxLength: caps.maxBytes }),
  };
}
