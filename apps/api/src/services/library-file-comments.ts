/**
 * Library file comment authorization.
 *
 * `project_files` lives in D1; comment threads live in the per-project
 * ProjectData Durable Object, which has no D1 access. So the file→project
 * binding has to be proven here, at the control plane, before any DO call.
 *
 * Shared by the HTTP routes (`routes/library-comments.ts`) and the MCP tools
 * (`routes/mcp/library-file-comment-tools.ts`) — the two had separate copies of
 * this query (.claude/rules/24-no-duplicate-ui-controls.md).
 */

import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { CommentNotFoundError } from '../durable-objects/project-data/comment-contracts';
import type { Env } from '../env';

/**
 * Proves `fileId` names a library file belonging to `projectId`.
 *
 * Throws `CommentNotFoundError('Library file')` for both "no such file" and
 * "file belongs to another project" so the response cannot be used to probe for
 * the existence of another project's files (.claude/rules/11-fail-fast-patterns.md,
 * "Project-Scoped Read Requirements").
 *
 * Only the entry points that can create a thread for a *new* fileId need this:
 * list and create. Reply/resolve/reopen reach their thread through a
 * `WHERE id = ? AND file_id = ?` lookup inside the project's own DO, so an
 * existing thread is already proof the binding was checked at create time —
 * re-checking costs a D1 round trip and proves nothing new
 * (.claude/rules/60-request-io-and-bundle-budgets.md).
 */
export async function assertLibraryFileInProject(
  env: Env,
  projectId: string,
  fileId: string
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const file = await db.query.projectFiles.findFirst({
    where: (f, { and, eq }) => and(eq(f.projectId, projectId), eq(f.id, fileId)),
    columns: { id: true },
  });
  if (!file) throw new CommentNotFoundError('Library file');
}
