import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ArchitectureRelationship, ArchitectureThread, SourceRef } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import type { ApiClient, MutationState, PreviewState, Selection } from './types';

interface TargetDescription {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  description?: string;
  sources: SourceRef[];
}

interface InspectorProps {
  api: ApiClient;
  model: ViewerModel;
  selection?: Selection;
  focusId?: string;
  mobileOpen: boolean;
  onClose: () => void;
  onOpenStructure: (id: string) => void;
  onReload: () => Promise<void>;
}

export function Inspector({
  api,
  model,
  selection,
  focusId,
  mobileOpen,
  onClose,
  onOpenStructure,
  onReload,
}: InspectorProps) {
  const targetId = selection?.id ?? focusId ?? model.summary.roots[0]?.id;
  const target = useMemo(() => describeTarget(model, targetId), [model, targetId]);
  const threads = model.workspace.threads.filter((thread) => thread.target === targetId);
  const [preview, setPreview] = useState<PreviewState>({ loading: false });
  const [question, setQuestion] = useState({ title: '', body: '' });
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [mutation, setMutation] = useState<MutationState>({ saving: false });
  const inspectorRef = useRef<HTMLElement | null>(null);

  useEffect(() => setPreview({ loading: false }), [targetId]);

  useEffect(() => {
    if (!mobileOpen || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    inspectorRef.current?.focus();
  }, [mobileOpen]);

  async function loadSource(source: SourceRef, sourceIndex: number) {
    if (!targetId) return;
    setPreview({ loading: true });
    try {
      setPreview({ loading: false, preview: await api.loadSource(targetId, source, sourceIndex) });
    } catch (error) {
      setPreview({ loading: false, error: errorMessage(error) });
    }
  }

  async function createQuestion(event: FormEvent) {
    event.preventDefault();
    if (!targetId || mutation.saving) return;
    setMutation({ saving: true });
    try {
      const result = await api.createThread({
        target: targetId,
        title: question.title,
        body: question.body,
      });
      setQuestion({ title: '', body: '' });
      setMutation({ saving: false, artifactPath: result.artifactPath });
      await onReload();
    } catch (error) {
      setMutation({ saving: false, error: errorMessage(error) });
    }
  }

  async function reply(thread: ArchitectureThread) {
    const body = replyDrafts[thread.id] ?? '';
    if (!body.trim() || mutation.saving) return;
    setMutation({ saving: true });
    try {
      const result = await api.replyToThread(thread.id, { body });
      setReplyDrafts((drafts) => ({ ...drafts, [thread.id]: '' }));
      setMutation({ saving: false, artifactPath: result.artifactPath });
      await onReload();
    } catch (error) {
      setMutation({ saving: false, error: errorMessage(error) });
    }
  }

  return (
    <aside
      ref={inspectorRef}
      className={`architecture-inspector ${mobileOpen ? 'is-open' : ''}`}
      aria-label="Architecture inspector"
      aria-live="polite"
      tabIndex={-1}
    >
      <div className="inspector-head">
        <div>
          <p className="eyebrow">{target?.kind ?? 'Overview'}</p>
          <h2>{target?.title ?? model.summary.name}</h2>
        </div>
        <button type="button" className="mobile-close" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted break-text">
        {target?.summary ??
          target?.description ??
          model.summary.description ??
          'No description yet.'}
      </p>
      {targetId && (
        <Relationships model={model} targetId={targetId} onOpenStructure={onOpenStructure} />
      )}
      {targetId && (
        <section>
          <h3>Source anchors</h3>
          <SourceAnchors sources={target?.sources ?? []} onLoad={loadSource} />
          <SourcePreview preview={preview} />
        </section>
      )}
      {targetId && (
        <section>
          <h3>Threads</h3>
          <ThreadList
            threads={threads}
            drafts={replyDrafts}
            saving={mutation.saving}
            onDraft={setReplyDrafts}
            onReply={reply}
          />
          <form className="stack" onSubmit={createQuestion}>
            <label>
              Question title
              <input
                value={question.title}
                onChange={(event) => setQuestion({ ...question, title: event.target.value })}
                required
              />
            </label>
            <label>
              Question
              <textarea
                value={question.body}
                onChange={(event) => setQuestion({ ...question, body: event.target.value })}
                required
              />
            </label>
            <button type="submit" disabled={mutation.saving}>
              Create question
            </button>
          </form>
          {mutation.artifactPath && <p className="success">Saved to {mutation.artifactPath}</p>}
          {mutation.error && <p className="error">{mutation.error}</p>}
        </section>
      )}
    </aside>
  );
}

function Relationships({
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
  return (
    <section className="relationship-grid">
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
    </section>
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

function SourceAnchors({
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

function SourcePreview({ preview }: { preview: PreviewState }) {
  if (preview.loading) return <p className="muted">Loading source preview…</p>;
  if (preview.error) return <p className="error">{preview.error}</p>;
  if (!preview.preview) return null;
  return (
    <pre className="source-preview" aria-label="Source preview">
      <code>{preview.preview.content}</code>
    </pre>
  );
}

function ThreadList({
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

function describeTarget(model: ViewerModel, id?: string): TargetDescription | undefined {
  const element = model.workspace.elements.find((item) => item.id === id);
  if (element) return { ...element, sources: element.sourceRefs ?? [] };
  const flow = model.workspace.flows.find((item) => item.id === id);
  if (flow) return { ...flow, kind: 'flow', sources: flow.sourceRefs ?? [] };
  const machine = model.workspace.stateMachines.find((item) => item.id === id);
  if (machine) return { ...machine, kind: 'state machine', sources: machine.sourceRefs ?? [] };
  const relationship = model.workspace.relationships.find((item) => item.id === id);
  if (relationship) {
    return {
      id: relationship.id,
      kind: relationship.type ?? 'relationship',
      title: relationship.title ?? relationship.id,
      description: relationship.description,
      summary: `${relationship.from} → ${relationship.to}`,
      sources: relationship.sourceRefs ?? [],
    };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.';
}
