import {
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ArchitectureThread, SourceRef } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import { Relationships, SourceAnchors, SourcePreview, ThreadList } from './InspectorSections';
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
  const controller = useInspectorController({
    api,
    focusId,
    mobileOpen,
    model,
    onReload,
    selection,
  });
  return (
    <aside
      ref={controller.inspectorRef}
      className={`architecture-inspector ${mobileOpen ? 'is-open' : ''}`}
      aria-label="Architecture inspector"
      aria-live="polite"
      aria-modal={mobileOpen || undefined}
      role={mobileOpen ? 'dialog' : 'complementary'}
      tabIndex={-1}
    >
      <InspectorHeader controller={controller} model={model} onClose={onClose} />
      <InspectorTarget controller={controller} model={model} onOpenStructure={onOpenStructure} />
    </aside>
  );
}

interface InspectorController {
  createQuestion: (event: FormEvent) => Promise<void>;
  inspectorRef: RefObject<HTMLElement | null>;
  loadSource: (source: SourceRef, sourceIndex: number) => Promise<void>;
  mutation: MutationState;
  preview: PreviewState;
  question: { title: string; body: string };
  reply: (thread: ArchitectureThread) => Promise<void>;
  replyDrafts: Record<string, string>;
  setQuestion: Dispatch<SetStateAction<{ title: string; body: string }>>;
  setReplyDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  target?: TargetDescription;
  targetId?: string;
  threads: ArchitectureThread[];
}

function useInspectorController({
  api,
  model,
  selection,
  focusId,
  mobileOpen,
  onReload,
}: Pick<
  InspectorProps,
  'api' | 'model' | 'selection' | 'focusId' | 'mobileOpen' | 'onReload'
>): InspectorController {
  const targetId = selection?.id ?? focusId ?? model.summary.roots[0]?.id;
  const target = useMemo(() => describeTarget(model, targetId), [model, targetId]);
  const threads = model.workspace.threads.filter((thread) => thread.target === targetId);
  const state = useInspectorState();
  useResetOnTarget(
    targetId,
    state.targetRevisionRef,
    state.setPreview,
    state.setQuestion,
    state.setReplyDrafts,
    state.setMutation
  );
  useMobileDialog(mobileOpen, targetId, state.inspectorRef);
  return useInspectorActions(api, onReload, targetId, target, threads, state);
}

function useInspectorState() {
  const [preview, setPreview] = useState<PreviewState>({ loading: false });
  const [question, setQuestion] = useState({ title: '', body: '' });
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [mutation, setMutation] = useState<MutationState>({ saving: false });
  const inspectorRef = useRef<HTMLElement | null>(null);
  const targetRevisionRef = useRef(0);
  return {
    inspectorRef,
    mutation,
    preview,
    question,
    replyDrafts,
    setMutation,
    setPreview,
    setQuestion,
    setReplyDrafts,
    targetRevisionRef,
  };
}

function useInspectorActions(
  api: ApiClient,
  onReload: () => Promise<void>,
  targetId: string | undefined,
  target: TargetDescription | undefined,
  threads: ArchitectureThread[],
  state: ReturnType<typeof useInspectorState>
): InspectorController {
  const loadSource = useSourceLoader(api, targetId, state.targetRevisionRef, state.setPreview);
  const createQuestion = useQuestionCreator(
    api,
    targetId,
    state.targetRevisionRef,
    state.question,
    state.mutation.saving,
    state.setQuestion,
    state.setMutation,
    onReload
  );
  const reply = useThreadReply(
    api,
    state.targetRevisionRef,
    state.replyDrafts,
    state.mutation.saving,
    state.setReplyDrafts,
    state.setMutation,
    onReload
  );
  return { ...state, createQuestion, loadSource, reply, target, targetId, threads };
}

function useResetOnTarget(
  targetId: string | undefined,
  revision: MutableRefObject<number>,
  setPreview: Dispatch<SetStateAction<PreviewState>>,
  setQuestion: Dispatch<SetStateAction<{ title: string; body: string }>>,
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>,
  setMutation: Dispatch<SetStateAction<MutationState>>
): void {
  useEffect(() => {
    revision.current += 1;
    setPreview({ loading: false });
    setQuestion({ title: '', body: '' });
    setDrafts({});
    setMutation({ saving: false });
  }, [targetId, revision, setDrafts, setMutation, setPreview, setQuestion]);
}

function useMobileDialog(
  open: boolean,
  targetId: string | undefined,
  inspectorRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const inspector = inspectorRef.current;
    if (!open || !inspector) return;
    const overflow = document.body.style.overflow;
    const selector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    document.body.style.overflow = 'hidden';
    inspector.querySelector<HTMLElement>(selector)?.focus();
    const trap = (event: KeyboardEvent) => trapDialogFocus(event, inspector, selector);
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      document.body.style.overflow = overflow;
    };
  }, [inspectorRef, open, targetId]);
}

function trapDialogFocus(event: KeyboardEvent, inspector: HTMLElement, selector: string): void {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(inspector.querySelectorAll<HTMLElement>(selector));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  const activeInside =
    document.activeElement instanceof Node && inspector.contains(document.activeElement);
  if (event.shiftKey && (!activeInside || document.activeElement === first)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
    event.preventDefault();
    first?.focus();
  }
}

function useSourceLoader(
  api: ApiClient,
  targetId: string | undefined,
  revisionRef: MutableRefObject<number>,
  setPreview: Dispatch<SetStateAction<PreviewState>>
) {
  return async (source: SourceRef, sourceIndex: number) => {
    if (!targetId) return;
    const revision = revisionRef.current;
    setPreview({ loading: true });
    try {
      const loaded = await api.loadSource(targetId, source, sourceIndex);
      if (revision === revisionRef.current) setPreview({ loading: false, preview: loaded });
    } catch (error) {
      if (revision === revisionRef.current)
        setPreview({ loading: false, error: errorMessage(error) });
    }
  };
}

function useQuestionCreator(
  api: ApiClient,
  targetId: string | undefined,
  revisionRef: MutableRefObject<number>,
  question: { title: string; body: string },
  saving: boolean,
  setQuestion: Dispatch<SetStateAction<{ title: string; body: string }>>,
  setMutation: Dispatch<SetStateAction<MutationState>>,
  onReload: () => Promise<void>
) {
  return async (event: FormEvent) => {
    event.preventDefault();
    if (!targetId || saving) return;
    const revision = revisionRef.current;
    setMutation({ saving: true });
    try {
      const result = await api.createThread({
        target: targetId,
        title: question.title,
        body: question.body,
      });
      if (revision !== revisionRef.current) return;
      setQuestion({ title: '', body: '' });
      setMutation({ saving: false, artifactPath: result.artifactPath });
      await onReload();
    } catch (error) {
      if (revision === revisionRef.current)
        setMutation({ saving: false, error: errorMessage(error) });
    }
  };
}

function useThreadReply(
  api: ApiClient,
  revisionRef: MutableRefObject<number>,
  drafts: Record<string, string>,
  saving: boolean,
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>,
  setMutation: Dispatch<SetStateAction<MutationState>>,
  onReload: () => Promise<void>
) {
  return async (thread: ArchitectureThread) => {
    const body = drafts[thread.id] ?? '';
    if (!body.trim() || saving) return;
    const revision = revisionRef.current;
    setMutation({ saving: true });
    try {
      const result = await api.replyToThread(thread.id, { body });
      if (revision !== revisionRef.current) return;
      setDrafts((all) => ({ ...all, [thread.id]: '' }));
      setMutation({ saving: false, artifactPath: result.artifactPath });
      await onReload();
    } catch (error) {
      if (revision === revisionRef.current)
        setMutation({ saving: false, error: errorMessage(error) });
    }
  };
}

function InspectorHeader({
  controller,
  model,
  onClose,
}: {
  controller: InspectorController;
  model: ViewerModel;
  onClose: () => void;
}) {
  return (
    <div className="inspector-head">
      <div>
        <p className="eyebrow">{controller.target?.kind ?? 'Overview'}</p>
        <h2>{controller.target?.title ?? model.summary.name}</h2>
      </div>
      <button type="button" className="mobile-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function InspectorTarget({
  controller,
  model,
  onOpenStructure,
}: {
  controller: InspectorController;
  model: ViewerModel;
  onOpenStructure: (id: string) => void;
}) {
  return (
    <>
      <p className="muted break-text">
        {controller.target?.summary ??
          controller.target?.description ??
          model.summary.description ??
          'No description yet.'}
      </p>
      {controller.targetId && (
        <Relationships
          model={model}
          targetId={controller.targetId}
          onOpenStructure={onOpenStructure}
        />
      )}
      {controller.targetId && (
        <section>
          <h3>Source anchors</h3>
          <SourceAnchors
            sources={controller.target?.sources ?? []}
            onLoad={controller.loadSource}
          />
          <SourcePreview preview={controller.preview} />
        </section>
      )}
      {controller.targetId && <ThreadSection controller={controller} />}
    </>
  );
}

function ThreadSection({ controller }: { controller: InspectorController }) {
  return (
    <section>
      <h3>Threads</h3>
      <ThreadList
        threads={controller.threads}
        drafts={controller.replyDrafts}
        saving={controller.mutation.saving}
        onDraft={controller.setReplyDrafts}
        onReply={controller.reply}
      />
      <form className="stack" onSubmit={controller.createQuestion}>
        <label>
          Question title
          <input
            value={controller.question.title}
            onChange={(event) =>
              controller.setQuestion({ ...controller.question, title: event.target.value })
            }
            required
          />
        </label>
        <label>
          Question
          <textarea
            value={controller.question.body}
            onChange={(event) =>
              controller.setQuestion({ ...controller.question, body: event.target.value })
            }
            required
          />
        </label>
        <button type="submit" disabled={controller.mutation.saving}>
          Create question
        </button>
      </form>
      {controller.mutation.artifactPath && (
        <p className="success">Saved to {controller.mutation.artifactPath}</p>
      )}
      {controller.mutation.error && <p className="error">{controller.mutation.error}</p>}
    </section>
  );
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
