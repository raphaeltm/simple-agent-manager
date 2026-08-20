import { type Dispatch, memo, type SetStateAction } from 'react';

import type { ArchitectureRelationship, ArchitectureThread, SourceRef } from '../schemas';
import type { ProjectionIndex } from './projections';
import type { PreviewState } from './types';

export function Relationships({
  projectionIndex,
  targetId,
  onOpenStructure,
}: {
  projectionIndex: ProjectionIndex;
  targetId: string;
  onOpenStructure: (id: string) => void;
}) {
  const relationships = projectionIndex.relationshipsByElement.get(targetId) ?? [];
  const incoming = relationships.filter((relationship) => relationship.to === targetId);
  const outgoing = relationships.filter((relationship) => relationship.from === targetId);
  if (incoming.length === 0 && outgoing.length === 0) {
    return <p className="muted empty-connection">No connected relationships in this scope.</p>;
  }
  return (
    <div className="relationship-grid">
      <RelationshipList
        title="Incoming"
        relationships={incoming}
        edge="from"
        onOpenStructure={onOpenStructure}
      />
      <RelationshipList
        title="Outgoing"
        relationships={outgoing}
        edge="to"
        onOpenStructure={onOpenStructure}
      />
    </div>
  );
}

function RelationshipList({
  title,
  relationships,
  edge,
  onOpenStructure,
}: {
  title: string;
  relationships: ArchitectureRelationship[];
  edge: 'from' | 'to';
  onOpenStructure: (id: string) => void;
}) {
  return (
    <div>
      <h3 className="relationship-heading">
        {title} <span>{relationships.length}</span>
      </h3>
      {relationships.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        relationships.map((relationship) => (
          <button
            key={relationship.id}
            type="button"
            className="text-row"
            onClick={() => onOpenStructure(relationship[edge])}
          >
            {relationship.title ?? relationship.id}
          </button>
        ))
      )}
    </div>
  );
}

export function SourceAnchors({
  sources,
  onLoad,
}: {
  sources: SourceRef[];
  onLoad: (source: SourceRef, index: number, fullFile?: boolean) => void;
}) {
  if (sources.length === 0) return <p className="muted">No source anchors.</p>;
  return sources.map((source, index) => (
    <div className="source-anchor-row" key={`${source.path}:${index}`}>
      <button type="button" className="source-link" onClick={() => onLoad(source, index)}>
        {source.label ?? source.path}:
        {source.lineGroups ? lineGroupSummary(source) : (source.startLine ?? 1)}
      </button>
      <button
        type="button"
        className="ghost-action compact-action"
        onClick={() => onLoad(source, index, true)}
      >
        Full file
      </button>
    </div>
  ));
}

export function SourcePreview({ preview }: { preview: PreviewState }) {
  if (preview.loading)
    return (
      <p className="muted" role="status">
        Loading source preview…
      </p>
    );
  if (preview.error)
    return (
      <p className="error" role="alert">
        {preview.error}
      </p>
    );
  if (!preview.preview) return null;
  return (
    <div className="source-frame">
      <div className="source-meta">
        <span>{preview.preview.path}</span>
        <span>
          L{preview.preview.startLine}–{preview.preview.endLine}
        </span>
      </div>
      <pre className="source-preview" aria-label="Source preview">
        <code>
          {preview.preview.groups
            ? groupedContent(preview.preview.groups)
            : preview.preview.content}
        </code>
      </pre>
    </div>
  );
}

function lineGroupSummary(source: SourceRef): string {
  return (source.lineGroups ?? [])
    .map(
      (group) =>
        `L${group.startLine}${group.endLine === group.startLine ? '' : `–${group.endLine}`}`
    )
    .join(', ');
}

function groupedContent(groups: NonNullable<PreviewState['preview']>['groups']): string {
  return (groups ?? [])
    .map((group) => {
      const label = group.label ? `${group.label} ` : '';
      return `${label}L${group.startLine}–${group.endLine}\n${group.content}`;
    })
    .join('\n\n');
}

export function ThreadList({
  threads,
  drafts,
  saving,
  onDraft,
  onReply,
}: {
  threads: ArchitectureThread[];
  drafts: Record<string, string>;
  saving: boolean;
  onDraft: Dispatch<SetStateAction<Record<string, string>>>;
  onReply: (thread: ArchitectureThread) => void;
}) {
  if (threads.length === 0)
    return (
      <p className="muted">
        No discussion yet. Ask a question here; agents can reply from the workspace inbox.
      </p>
    );
  return threads.map((thread) => (
    <article className="thread" key={thread.id}>
      <header className="thread-head">
        <h4>{thread.title}</h4>
        <span className={`pill ${thread.status}`}>{thread.status}</span>
      </header>
      <ThreadConversation thread={thread} />
      <label>
        Reply to {thread.title}
        <textarea
          value={drafts[thread.id] ?? ''}
          onChange={(event) => onDraft((all) => ({ ...all, [thread.id]: event.target.value }))}
        />
      </label>
      <button type="button" disabled={saving} onClick={() => onReply(thread)}>
        Reply in thread
      </button>
    </article>
  ));
}

const ThreadConversation = memo(function ThreadConversation({
  thread,
}: {
  thread: ArchitectureThread;
}) {
  return (
    <ol className="thread-messages" aria-label={`${thread.title} messages`}>
      {thread.messages.map((message) => (
        <li
          className={`thread-message ${message.author.toLowerCase() === 'agent' ? 'is-agent' : ''}`}
          key={message.id}
        >
          <div className="message-meta">
            <strong aria-label={`Author: ${message.author}`}>{authorLabel(message.author)}</strong>
            <time dateTime={message.createdAt}>{utcTimestamp(message.createdAt)}</time>
          </div>
          <p className="message break-text">{message.body}</p>
        </li>
      ))}
    </ol>
  );
});

function authorLabel(author: string): string {
  const normalized = author.trim().toLowerCase();
  if (normalized === 'agent') return 'Agent';
  if (normalized === 'user') return 'User';
  return author.trim();
}

function utcTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
