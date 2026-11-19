/**
 * Wire shapes shared by the message-comment and library-file-comment clients. The backend
 * and the MCP surface name the author's label differently (`name` vs `displayName`); both
 * clients map through `mapAuthor` so the UI sees one shape.
 */
import type { MessageCommentAuthor } from './comments';

export type BackendAuthor = {
  id: string;
  kind: 'human' | 'agent';
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
};

export type BackendReply = {
  id: string;
  clientMutationId?: string | null;
  author: BackendAuthor;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  sentToAgent?: boolean;
  mentions?: unknown;
};

export function mapAuthor(author: BackendAuthor): MessageCommentAuthor {
  return {
    id: author.id,
    kind: author.kind,
    name: author.name ?? author.displayName ?? null,
    email: author.email ?? null,
    avatarUrl: author.avatarUrl ?? null,
  };
}
