import type {
  CreateNodeRequest,
  Event,
  NodeLogFilter,
  NodeLogResponse,
  NodeResponse,
  NodeSystemInfo,
} from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

export async function listNodes(): Promise<NodeResponse[]> {
  return request<NodeResponse[]>('/api/nodes');
}

export async function getNode(id: string): Promise<NodeResponse> {
  return request<NodeResponse>(`/api/nodes/${id}`);
}

export async function createNode(data: CreateNodeRequest): Promise<NodeResponse> {
  return request<NodeResponse>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function stopNode(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/nodes/${id}/stop`, {
    method: 'POST',
  });
}

export async function deleteNode(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/nodes/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Fetch node system info via the control plane proxy.
 * Proxied for the same reason as events (vm-* DNS lacks SSL).
 */
export async function getNodeSystemInfo(nodeId: string): Promise<NodeSystemInfo> {
  return request<NodeSystemInfo>(`/api/nodes/${nodeId}/system-info`);
}

/**
 * Fetch node logs via the control plane proxy.
 */
export async function getNodeLogs(
  nodeId: string,
  filter?: Partial<NodeLogFilter>
): Promise<NodeLogResponse> {
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level) params.set('level', filter.level);
  if (filter?.container) params.set('container', filter.container);
  if (filter?.since) params.set('since', filter.since);
  if (filter?.until) params.set('until', filter.until);
  if (filter?.search) params.set('search', filter.search);
  if (filter?.cursor) params.set('cursor', filter.cursor);
  if (filter?.limit) params.set('limit', String(filter.limit));

  const qs = params.toString();
  return request<NodeLogResponse>(
    `/api/nodes/${nodeId}/logs${qs ? `?${qs}` : ''}`
  );
}

/** Build the WebSocket URL for real-time log streaming. */
export function getNodeLogStreamUrl(nodeId: string, filter?: Partial<NodeLogFilter>): string {
  const base = API_URL.replace(/^http/, 'ws');
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level) params.set('level', filter.level);
  if (filter?.container) params.set('container', filter.container);

  const qs = params.toString();
  return `${base}/api/nodes/${nodeId}/logs/stream${qs ? `?${qs}` : ''}`;
}

/**
 * Fetch and trigger a browser file download for the given URL.
 * Extracts filename from Content-Disposition header if available, otherwise uses fallback.
 */
async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to download ${fallbackFilename}: ${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filenameMatch?.[1] || fallbackFilename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Download the raw SQLite event database from a node.
 */
export async function downloadNodeEvents(nodeId: string): Promise<void> {
  return downloadFile(`${API_URL}/api/nodes/${nodeId}/events/export`, `events-${nodeId}.db`);
}

/**
 * Download the raw SQLite metrics database from a node.
 */
export async function downloadNodeMetrics(nodeId: string): Promise<void> {
  return downloadFile(`${API_URL}/api/nodes/${nodeId}/metrics/export`, `metrics-${nodeId}.db`);
}

/**
 * Download the full debug package (tar.gz) from a node.
 * Contains all logs, metrics, events, system info, and diagnostic data.
 */
export async function downloadNodeDebugPackage(nodeId: string): Promise<void> {
  return downloadFile(`${API_URL}/api/nodes/${nodeId}/debug-package`, `debug-${nodeId}.tar.gz`);
}

/**
 * Fetch node events via the control plane proxy.
 * Node events are proxied because vm-* DNS records are DNS-only (no Cloudflare SSL
 * termination), so the browser cannot reach them directly from an HTTPS page.
 */
export async function listNodeEvents(
  nodeId: string,
  limit = 100
): Promise<{ events: Event[]; nextCursor?: string | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));

  return request<{ events: Event[]; nextCursor?: string | null }>(
    `/api/nodes/${nodeId}/events?${params.toString()}`
  );
}
