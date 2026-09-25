import { type Context, type Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { formatIssues } from '../../schemas';
import * as projectDataService from '../../services/project-data';
import { signalWorkspaceDeletionUnconfirmedCallback } from '../../services/workspace-deletion-callback-signal';
import {
  sameWorkspaceCallbackIdentity,
  type WorkspaceCallbackIdentitySnapshot,
  verifyWorkspaceCallbackAuth,
} from './_helpers';

type RuntimeContext = Context<{ Bindings: Env }>;
type MessageContext = {
  workspaceId: string;
  projectId: string | null;
  sessionId: string;
  messageCount: number;
};

type Dependencies<
  W extends WorkspaceCallbackIdentitySnapshot & { projectId: string | null; status: string },
> = {
  loadWorkspace: (env: Env, workspaceId: string) => Promise<W | null>;
  maybeTerminal: (
    c: RuntimeContext,
    workspace: W | null,
    workspaceId: string,
    sessionId: string,
    count: number
  ) => Response | null;
  assertAccepts: (
    c: RuntimeContext,
    workspace: W | null,
    workspaceId: string,
    sessionId: string,
    count: number
  ) => void;
  terminalResponse: (
    c: RuntimeContext,
    context: MessageContext,
    status: string,
    reason: string
  ) => Response;
  sessionLimitResponse: (
    c: RuntimeContext,
    context: MessageContext & { projectId: string }
  ) => Response;
  readBody: (request: Request, limit: number) => Promise<string>;
  maxPayloadBytes: (env: Env) => number;
  maxMessageBytes: (env: Env) => number;
  validMessageRole: (role: string) => boolean;
};

const MessageUploadSchema = v.variant('action', [
  v.object({
    action: v.literal('part'),
    sessionId: v.string(),
    messageId: v.string(),
    field: v.picklist(['content', 'toolMetadata']),
    part: v.number(),
    data: v.string(),
  }),
  v.object({
    action: v.literal('commit'),
    sessionId: v.string(),
    messageId: v.string(),
    role: v.string(),
    timestamp: v.string(),
    origin: v.nullable(v.string()),
    sequence: v.number(),
    contentParts: v.number(),
    metadataParts: v.number(),
    contentSha256: v.string(),
    metadataSha256: v.string(),
  }),
]);

/** Upload private bounded parts, then commit one canonical message after verification. */
export function registerMessageUploadRoute<
  W extends WorkspaceCallbackIdentitySnapshot & { projectId: string | null; status: string },
>(routes: Hono<{ Bindings: Env }>, deps: Dependencies<W>): void {
  routes.post('/:id/messages/upload', async (c) => {
    const workspaceId = c.req.param('id');
    await verifyWorkspaceCallbackAuth(c, workspaceId);
    const workspace = await deps.loadWorkspace(c.env, workspaceId);
    const preflight = deps.maybeTerminal(c, workspace, workspaceId, '', 0);
    if (preflight) {
      await signalWorkspaceDeletionUnconfirmedCallback(c.env, workspaceId, 'messages');
      return preflight;
    }

    const rawBody = await deps.readBody(c.req.raw, deps.maxPayloadBytes(c.env));
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw errors.badRequest('Invalid JSON in message upload');
    }
    const result = v.safeParse(MessageUploadSchema, parsed);
    if (!result.success) throw errors.badRequest(formatIssues(result.issues));
    const input = result.output;
    if (!input.sessionId || !input.messageId)
      throw errors.badRequest('Message identity is required');

    const currentWorkspace = await deps.loadWorkspace(c.env, workspaceId);
    const terminal = deps.maybeTerminal(c, currentWorkspace, workspaceId, input.sessionId, 1);
    if (terminal) return terminal;
    if (
      !workspace ||
      !currentWorkspace ||
      !sameWorkspaceCallbackIdentity(workspace, currentWorkspace)
    ) {
      return deps.terminalResponse(
        c,
        {
          workspaceId,
          projectId: currentWorkspace?.projectId ?? null,
          sessionId: input.sessionId,
          messageCount: 1,
        },
        currentWorkspace?.status ?? 'missing',
        'workspace_incarnation_changed'
      );
    }
    deps.assertAccepts(c, currentWorkspace, workspaceId, input.sessionId, 1);
    if (!currentWorkspace.projectId) throw errors.badRequest('Workspace has no project');

    if (input.action === 'part') {
      if (new TextEncoder().encode(input.data).byteLength > deps.maxMessageBytes(c.env)) {
        throw errors.badRequest('Message upload part exceeds individual content limit');
      }
      try {
        await projectDataService.storeMessageUploadPart(c.env, currentWorkspace.projectId, input);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('upload quarantine exceeds') ||
            error.message.includes('upload is abandoned'))
        ) {
          throw errors.conflict(error.message);
        }
        throw error;
      }
      return c.json({ accepted: true });
    }
    if (
      !deps.validMessageRole(input.role) ||
      !Number.isSafeInteger(input.sequence) ||
      !Number.isFinite(Date.parse(input.timestamp)) ||
      (input.origin !== null && input.origin !== 'user' && input.origin !== 'system') ||
      !/^[0-9a-f]{64}$/.test(input.contentSha256) ||
      !/^[0-9a-f]{64}$/.test(input.metadataSha256)
    ) {
      throw errors.badRequest('Invalid message upload manifest');
    }
    const committed = await projectDataService.commitMessageUpload(
      c.env,
      currentWorkspace.projectId,
      input
    );
    if (committed.limitReached) {
      return deps.sessionLimitResponse(c, {
        workspaceId,
        projectId: currentWorkspace.projectId,
        sessionId: input.sessionId,
        messageCount: 1,
      });
    }
    return c.json({ persisted: committed.persisted, duplicates: committed.duplicates });
  });
}
