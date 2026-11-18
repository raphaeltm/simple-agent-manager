/**
 * Who may see raw node debug packages in the Operations project library (policy a35180d5).
 *
 * Packages live under `/debug-packages/` in an ordinary project library, whose read paths admit
 * every project member. These helpers narrow those paths: in the app only superadmins see the
 * packages, and over MCP only a token that passes the Operations read gate does. Everyone else
 * gets the same not-found answer as for a missing file.
 */
import type { UserRole } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import type { McpTokenData } from '../mcp-token';
import {
  type OperationsAccessContext,
  OperationsAccessError,
  requireOperationsAccess,
} from '../operations-access';
import { DEBUG_PACKAGE_ROOT } from './debug-packages';

/** Library directory prefix (directories are stored with a trailing slash). */
export const DEBUG_PACKAGE_DIRECTORY_PREFIX = `${DEBUG_PACKAGE_ROOT}/`;

export function isDebugPackageDirectory(directory: string | null | undefined): boolean {
  return typeof directory === 'string' && directory.startsWith(DEBUG_PACKAGE_DIRECTORY_PREFIX);
}

/** App surfaces: only superadmins see debug packages. */
export function userMayReadDebugPackages(role: UserRole | string | null | undefined): boolean {
  return role === 'superadmin';
}

/** MCP surfaces: the grant when the token passes the Operations read gate, otherwise null. */
export async function mcpDebugPackageGrant(
  env: Env,
  tokenData: McpTokenData
): Promise<OperationsAccessContext | null> {
  try {
    return await requireOperationsAccess(env, tokenData, { capability: 'read' });
  } catch (error) {
    if (error instanceof OperationsAccessError) return null;
    throw error;
  }
}

/** `listFiles` options that hide debug packages unless the caller may read them. */
export function debugPackageListOptions(mayRead: boolean): { excludeDirectoryPrefix?: string } {
  return mayRead ? {} : { excludeDirectoryPrefix: DEBUG_PACKAGE_DIRECTORY_PREFIX };
}

/** App routes: a debug package answers "not found" to anyone but a superadmin. */
export function assertDebugPackageVisibleTo(role: string, directory: string): void {
  if (isDebugPackageDirectory(directory) && !userMayReadDebugPackages(role)) {
    throw errors.notFound('File');
  }
}

/**
 * MCP download/display of one file: null when the file is not a debug package; otherwise the
 * Operations grant, or `denied` when the token does not pass the gate.
 */
export async function mcpDebugPackageFileAccess(
  env: Env,
  tokenData: McpTokenData,
  directory: string
): Promise<null | 'denied' | OperationsAccessContext> {
  if (!isDebugPackageDirectory(directory)) return null;
  return (await mcpDebugPackageGrant(env, tokenData)) ?? 'denied';
}
