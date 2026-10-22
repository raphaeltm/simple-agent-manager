/**
 * Move files between the control plane and a running workspace through its VM agent.
 *
 * Used by the library MCP tools (upload/download/replace) and by agent model calls, which read
 * binary model inputs from, and write binary model outputs to, the calling agent's workspace.
 * Requests are signed with a short-lived terminal token for the workspace owner.
 */
import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { signTerminalToken } from './jwt';
import { fetchNodeAgent } from './node-agent';

type AppDb = DrizzleD1Database<typeof schema>;

export interface WorkspaceUploadInput {
  env: Env;
  vmBaseUrl: string;
  nodeId: string;
  workspaceId: string;
  userId: string;
  filename: string;
  data: ArrayBuffer;
  targetPath: string;
}

/** Timeout for VM agent file transfer calls. Override via LIBRARY_MCP_TRANSFER_TIMEOUT_MS. */
const DEFAULT_LIBRARY_MCP_TRANSFER_TIMEOUT_MS = 60_000;
function getTransferTimeout(env: Env): number {
  return parsePositiveInt(
    env.LIBRARY_MCP_TRANSFER_TIMEOUT_MS,
    DEFAULT_LIBRARY_MCP_TRANSFER_TIMEOUT_MS
  );
}

/** Largest workspace file pulled into a Worker; guards the 128 MB isolate heap. */
const DEFAULT_LIBRARY_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Validate that a path is relative and does not contain traversal segments.
 * Returns null if valid, or an error message if invalid.
 */
export function validateRelativePath(path: string): string | null {
  if (path.startsWith('/')) {
    return 'Path must be relative (cannot start with /)';
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    return 'Path cannot contain ".." segments';
  }
  if (segments.includes('.')) {
    return 'Path cannot contain "." segments';
  }
  return null;
}

/**
 * Resolve the workspace's node ID and build the VM agent base URL.
 * Returns null and a JSON-RPC error if the workspace is not found or not running.
 */
export async function resolveWorkspaceVmUrl(
  db: AppDb,
  env: Env,
  workspaceId: string,
  projectId: string
): Promise<{ vmBaseUrl: string; nodeId: string } | { error: string }> {
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
    })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.projectId, projectId)))
    .limit(1);

  if (!workspace) {
    return { error: 'Workspace not found' };
  }
  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    return { error: `Workspace is not running (status: ${workspace.status})` };
  }
  if (!workspace.nodeId) {
    return { error: 'Workspace has no assigned node' };
  }

  const nodeIdLower = workspace.nodeId.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(nodeIdLower)) {
    return { error: 'Invalid node ID format' };
  }

  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const vmBaseUrl = `${protocol}://${nodeIdLower}.vm.${env.BASE_DOMAIN}:${port}`;
  return { vmBaseUrl, nodeId: workspace.nodeId };
}

/**
 * Upload a file to the workspace via VM agent multipart upload.
 */
export async function uploadToWorkspace(input: WorkspaceUploadInput): Promise<void> {
  const { env, vmBaseUrl, nodeId, workspaceId, userId, filename, data, targetPath } = input;
  const { token } = await signTerminalToken(userId, workspaceId, env);
  const url = `${vmBaseUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/upload`;

  const formData = new FormData();
  formData.append('destination', targetPath);
  formData.append('files', new Blob([data]), filename);

  // Use Authorization header for server-to-server calls (not query param)
  const res = await fetchNodeAgent(
    nodeId,
    env,
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    },
    getTransferTimeout(env)
  );

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    throw new Error(`VM agent upload failed: ${res.status} ${text}`);
  }
}

/**
 * Download a file from the workspace via VM agent.
 * Returns the file data as ArrayBuffer and the content type.
 */
export async function downloadFromWorkspace(
  env: Env,
  vmBaseUrl: string,
  nodeId: string,
  workspaceId: string,
  userId: string,
  filePath: string,
  maxBytesOverride?: number
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const { token } = await signTerminalToken(userId, workspaceId, env);
  const params = new URLSearchParams({ path: filePath });
  const url = `${vmBaseUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/download?${params.toString()}`;

  // Use Authorization header for server-to-server calls (not query param)
  const res = await fetchNodeAgent(
    nodeId,
    env,
    url,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    getTransferTimeout(env)
  );

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    if (res.status === 404) {
      throw new Error(`File not found in workspace: ${filePath}`);
    }
    throw new Error(`VM agent download failed: ${res.status} ${text}`);
  }

  // Guard against oversized responses to avoid OOM in Workers (128 MB heap)
  const contentLength = parseInt(res.headers.get('Content-Length') ?? '0', 10);
  const maxBytes =
    maxBytesOverride ??
    parsePositiveInt(env.LIBRARY_UPLOAD_MAX_BYTES, DEFAULT_LIBRARY_UPLOAD_MAX_BYTES);
  if (contentLength > maxBytes) {
    throw new Error(`File too large: ${contentLength} bytes exceeds maximum ${maxBytes}`);
  }

  const data = await res.arrayBuffer();
  const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
  return { data, contentType };
}
