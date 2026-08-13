import {
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ArchitectureThread, SourceRef } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import { Relationships, SourceAnchors, SourcePreview, ThreadList } from './InspectorSections';
import type { ProjectionIndex } from './projections';
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
  projectionIndex: ProjectionIndex;
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
  projectionIndex,
}: InspectorProps) {
  const controller = useInspectorController({
    api,
    focusId,
    mobileOpen,
    model,
    onReload,
    projectionIndex,
    selection,
  });
  return (
    <aside
      ref={controller.inspectorRef}
      className={`architecture-inspector ${mobileOpen ? 'is-open' : ''}`}
      aria-label="Architecture inspector"
      aria-modal={mobileOpen || undefined}
      role={mobileOpen ? 'dialog' : 'complementary'}
      tabIndex={-1}
    >
      <InspectorHeader controller={controller} model={model} onClose={onClose} />
      <InspectorTarget
        controller={controller}
        model={model}
        onOpenStructure={onOpenStructure}
        projectionIndex={projectionIndex}
      />
    </aside>
  );
}

interface InspectorController {
  askQuestion: () => void;
  createQuestion: (event: FormEvent) => Promise<void>;
  discussionHeadingRef: RefObject<HTMLHeadingElement | null>;
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
  projectionIndex,
}: Pick<
  InspectorProps,
  'api' | 'model' | 'selection' | 'focusId' | 'mobileOpen' | 'onReload' | 'projectionIndex'
>): InspectorController {
  const targetId = selection?.id ?? focusId ?? model.summary.roots[0]?.id;
  const target = useMemo(
    () => describeTarget(projectionIndex, targetId),
    [projectionIndex, targetId]
  );
  const threads = targetId ? (projectionIndex.threadsByTarget.get(targetId) ?? []) : [];
  const state = useInspectorState(targetId);
  useResetOnTarget(targetId, state.targetRevisionRef, state.setPreview, state.setMutation);
  useMobileDialog(mobileOpen, targetId, state.inspectorRef);
  useInspectorScrollReset(targetId, state.inspectorRef);
  return useInspectorActions(api, onReload, targetId, target, threads, state);
}

function useInspectorState(targetId: string | undefined) {
  const [preview, setPreview] = useState<PreviewState>({ loading: false });
  const [draftsByTarget, setDraftsByTarget] = useState<
    Record<string, { question: { title: string; body: string }; replies: Record<string, string> }>
  >({});
  const [mutation, setMutation] = useState<MutationState>({ saving: false });
  const discussionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const targetRevisionRef = useRef(0);
  const sourceRevisionRef = useRef(0);
  const latestTargetRef = useRef(targetId);
  latestTargetRef.current = targetId;
  const draft = targetId ? draftsByTarget[targetId] : undefined;
  const question = draft?.question ?? EMPTY_QUESTION;
  const replyDrafts = draft?.replies ?? {};
  const setQuestion = useCallback<Dispatch<SetStateAction<typeof EMPTY_QUESTION>>>(
    (action) => {
      if (!targetId) return;
      setDraftsByTarget((current) => {
        const previous = current[targetId] ?? { question: EMPTY_QUESTION, replies: {} };
        const question = typeof action === 'function' ? action(previous.question) : action;
        return { ...current, [targetId]: { ...previous, question } };
      });
    },
    [targetId]
  );
  const setReplyDrafts = useCallback<Dispatch<SetStateAction<Record<string, string>>>>(
    (action) => {
      if (!targetId) return;
      setDraftsByTarget((current) => {
        const previous = current[targetId] ?? { question: EMPTY_QUESTION, replies: {} };
        const replies = typeof action === 'function' ? action(previous.replies) : action;
        return { ...current, [targetId]: { ...previous, replies } };
      });
    },
    [targetId]
  );
  return {
    discussionHeadingRef,
    inspectorRef,
    mutation,
    preview,
    question,
    replyDrafts,
    setMutation,
    setPreview,
    setQuestion,
    setReplyDrafts,
    latestTargetRef,
    sourceRevisionRef,
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
  const loadSource = useSourceLoader(
    api,
    targetId,
    state.targetRevisionRef,
    state.latestTargetRef,
    state.sourceRevisionRef,
    state.setPreview
  );
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
  const askQuestion = () => {
    const inspector = state.inspectorRef.current;
    const heading = state.discussionHeadingRef.current;
    if (!inspector || !heading) return;
    const stickyHeader = inspector.querySelector<HTMLElement>('.inspector-head');
    const delta = heading.getBoundingClientRect().top - inspector.getBoundingClientRect().top;
    inspector.scrollTop = Math.max(
      0,
      inspector.scrollTop + delta - (stickyHeader?.offsetHeight ?? 0) - 12
    );
    heading.focus({ preventScroll: true });
  };
  return { ...state, askQuestion, createQuestion, loadSource, reply, target, targetId, threads };
}

function useResetOnTarget(
  targetId: string | undefined,
  revision: MutableRefObject<number>,
  setPreview: Dispatch<SetStateAction<PreviewState>>,
  setMutation: Dispatch<SetStateAction<MutationState>>
): void {
  useEffect(() => {
    revision.current += 1;
    setPreview({ loading: false });
    setMutation({ saving: false });
  }, [targetId, revision, setMutation, setPreview]);
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

function useInspectorScrollReset(
  targetId: string | undefined,
  inspectorRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const inspector = inspectorRef.current;
    if (inspector) inspector.scrollTop = 0;
  }, [inspectorRef, targetId]);
}

function useSourceLoader(
  api: ApiClient,
  targetId: string | undefined,
  targetRevisionRef: MutableRefObject<number>,
  latestTargetRef: MutableRefObject<string | undefined>,
  sourceRevisionRef: MutableRefObject<number>,
  setPreview: Dispatch<SetStateAction<PreviewState>>
) {
  return async (source: SourceRef, sourceIndex: number) => {
    if (!targetId) return;
    const targetRevision = targetRevisionRef.current;
    const sourceRevision = ++sourceRevisionRef.current;
    setPreview({ loading: true });
    try {
      const loaded = await api.loadSource(targetId, source, sourceIndex);
      if (
        targetId === latestTargetRef.current &&
        targetRevision === targetRevisionRef.current &&
        sourceRevision === sourceRevisionRef.current
      ) {
        setPreview({ loading: false, preview: loaded });
      }
    } catch (error) {
      if (
        targetId === latestTargetRef.current &&
        targetRevision === targetRevisionRef.current &&
        sourceRevision === sourceRevisionRef.current
      ) {
        setPreview({ loading: false, error: errorMessage(error) });
      }
    }
  };
}

const EMPTY_QUESTION = { title: '', body: '' };

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
        author: 'user',
      });
      setQuestion({ title: '', body: '' });
      try {
        await onReload();
        if (revision === revisionRef.current) {
          setMutation({ saving: false, artifactPath: result.artifactPath });
        }
      } catch (error) {
        if (revision === revisionRef.current) {
          setMutation({
            saving: false,
            artifactPath: result.artifactPath,
            refreshWarning: `Saved, but the view could not refresh: ${errorMessage(error)}`,
          });
        }
      }
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
      const result = await api.replyToThread(thread.id, { body, author: 'user' });
      setDrafts((all) => ({ ...all, [thread.id]: '' }));
      try {
        await onReload();
        if (revision === revisionRef.current) {
          setMutation({ saving: false, artifactPath: result.artifactPath });
        }
      } catch (error) {
        if (revision === revisionRef.current) {
          setMutation({
            saving: false,
            artifactPath: result.artifactPath,
            refreshWarning: `Saved, but the view could not refresh: ${errorMessage(error)}`,
          });
        }
      }
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
      <span className="sheet-grip" aria-hidden="true" />
      <div>
        <p className="eyebrow">{controller.target?.kind ?? 'Overview'}</p>
        <h2>{controller.target?.title ?? model.summary.name}</h2>
      </div>
      <div className="inspector-head-actions">
        <button
          type="button"
          className="ask-action"
          aria-label={`Ask about ${controller.target?.title ?? model.summary.name}`}
          onClick={controller.askQuestion}
        >
          Ask
        </button>
        <button type="button" className="mobile-close ghost-action" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function InspectorTarget({
  controller,
  model,
  onOpenStructure,
  projectionIndex,
}: {
  controller: InspectorController;
  model: ViewerModel;
  onOpenStructure: (id: string) => void;
  projectionIndex: ProjectionIndex;
}) {
  return (
    <>
      <section className="inspector-section inspector-overview">
        <h3>Overview</h3>
        <p className="muted break-text">
          {controller.target?.summary ??
            controller.target?.description ??
            model.summary.description ??
            'No description yet.'}
        </p>
      </section>
      {controller.targetId && (
        <section className="inspector-section">
          <h3>Connections</h3>
          <Relationships
            projectionIndex={projectionIndex}
            targetId={controller.targetId}
            onOpenStructure={onOpenStructure}
          />
        </section>
      )}
      {controller.targetId && (
        <section className="inspector-section">
          <h3>Source</h3>
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
    <section className="inspector-section discussion-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">File-backed Q&amp;A</p>
          <h3 ref={controller.discussionHeadingRef} tabIndex={-1}>
            Discussion
          </h3>
        </div>
        <span className="section-count">{controller.threads.length}</span>
      </div>
      <ThreadList
        threads={controller.threads}
        drafts={controller.replyDrafts}
        saving={controller.mutation.saving}
        onDraft={controller.setReplyDrafts}
        onReply={controller.reply}
      />
      <form className="stack question-form" onSubmit={controller.createQuestion}>
        <h4>Ask about this item</h4>
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
        <p className="success" role="status">
          Saved to {controller.mutation.artifactPath}
        </p>
      )}
      {controller.mutation.refreshWarning && (
        <p className="warning" role="status">
          {controller.mutation.refreshWarning}
        </p>
      )}
      {controller.mutation.error && (
        <p className="error" role="alert">
          {controller.mutation.error}
        </p>
      )}
    </section>
  );
}

function describeTarget(
  projectionIndex: ProjectionIndex,
  id?: string
): TargetDescription | undefined {
  const element = id ? projectionIndex.elementsById.get(id) : undefined;
  if (element) return { ...element, sources: element.sourceRefs ?? [] };
  const flow = id ? projectionIndex.flowsById.get(id) : undefined;
  if (flow) return { ...flow, kind: 'flow', sources: flow.sourceRefs ?? [] };
  const machine = id ? projectionIndex.machinesById.get(id) : undefined;
  if (machine) return { ...machine, kind: 'state machine', sources: machine.sourceRefs ?? [] };
  const relationship = id ? projectionIndex.relationshipsById.get(id) : undefined;
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
