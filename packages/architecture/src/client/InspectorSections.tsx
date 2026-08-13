import type { Dispatch, SetStateAction } from 'react';

import type { ArchitectureRelationship, ArchitectureThread, SourceRef } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import type { PreviewState } from './types';

export function Relationships({
  model,
  targetId,
  onOpenStructure,
}: {
  model: ViewerModel;
  targetId: string;
  onOpenStructure: (id: string) => void;
}) {
  const incoming = model.workspace.relationships.filter(
    (relationship) => relationship.to === targetId
  );
  const outgoing = model.workspace.relationships.filter(
    (relationship) => relationship.from === targetId
  );
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
      <h3>{title}</h3>
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
  onLoad: (source: SourceRef, index: number) => void;
}) {
  if (sources.length === 0) return <p className="muted">No source anchors.</p>;
  return sources.map((source, index) => (
    <button
      key={`${source.path}:${index}`}
      type="button"
      className="source-link"
      onClick={() => onLoad(source, index)}
    >
      {source.label ?? source.path}:{source.startLine ?? 1}
    </button>
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
        <code>{preview.preview.content}</code>
      </pre>
    </div>
  );
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
  if (threads.length === 0) return <p className="muted">No threads for this item.</p>;
  return threads.map((thread) => (
    <article className="thread" key={thread.id}>
      <h4>{thread.title}</h4>
      <p className={`pill ${thread.status}`}>{thread.status}</p>
      {thread.messages.map((message) => (
        <p className="message break-text" key={message.id}>
          {message.body}
        </p>
      ))}
      <label>
        Reply to {thread.title}
        <textarea
          value={drafts[thread.id] ?? ''}
          onChange={(event) => onDraft((all) => ({ ...all, [thread.id]: event.target.value }))}
        />
      </label>
      <button type="button" disabled={saving} onClick={() => onReply(thread)}>
        Reply
      </button>
    </article>
  ));
}
