/**
 * The four-step create/edit flow: what starts it → when → what happens → review. The step is in
 * the URL (`?step=`), so the browser's back button walks back through the steps; the form state
 * lives in this component, which stays mounted while only the query string changes.
 */
import { Button } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { useIsMobile } from '../../../hooks/useIsMobile';
import type { AutomationLookups } from '../data';
import { titleFromPrompt } from '../model';
import { Page } from '../page';
import { KindIcon, Panel } from '../ui';
import { type Errors, type StepId, validateStep } from './requests';
import { type EditorState, isTriggerStart } from './state';
import { StepStart, StepWhen } from './steps-start-when';
import { StepReview, StepWhat, whenSentence } from './steps-what-review';

const STEP_TEXT: Record<StepId, { label: string; title: string; hint: string }> = {
  start: {
    label: 'Start',
    title: 'What should start it?',
    hint: 'Pick one. You can change the details next.',
  },
  when: {
    label: 'Details',
    title: 'When should it run?',
    hint: 'Times use your time zone unless you pick another.',
  },
  what: {
    label: 'What happens',
    title: 'What should happen?',
    hint: 'Every run is an ordinary chat you can open later.',
  },
  review: {
    label: 'Review',
    title: 'Check and save',
    hint: 'Read it as a sentence. If it sounds right, it is.',
  },
};

const WHEN_TITLES: Partial<Record<NonNullable<EditorState['start']>, string>> = {
  github: 'Which GitHub activity?',
  webhook: 'Which calls should start it?',
  event: 'What should it wait for?',
};

export function EditorFlow({
  initial,
  steps,
  firstStep = steps[0] ?? 'review',
  title,
  submitLabel,
  closeTo,
  lookups,
  lockedNote,
  saving,
  saveError,
  onSave,
}: {
  initial: EditorState;
  steps: StepId[];
  /** Where the flow opens; earlier steps stay reachable with Back. */
  firstStep?: StepId;
  title: string;
  submitLabel: string;
  closeTo: string;
  lookups: AutomationLookups;
  lockedNote?: string;
  saving: boolean;
  saveError: { field?: string; message: string } | null;
  onSave: (state: EditorState) => void;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [confirmLeave, setConfirmLeave] = useState(false);
  const initialRef = useRef(JSON.stringify(initial));
  const dirty = JSON.stringify(state) !== initialRef.current;

  const requested = params.get('step') as StepId | null;
  const step: StepId = requested && steps.includes(requested) ? requested : firstStep;
  const index = steps.indexOf(step);
  const context = { canChangeAction: !lockedNote };

  // A reload or a shared link lands mid-flow with a fresh form: start over where the flow opens.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (requested && requested !== firstStep) {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete('step');
          return next;
        },
        { replace: true }
      );
    }
  }, [firstStep, requested, setParams]);

  // Leaving the tab with unsaved work asks first. In-app links go through `leave()`.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // A save error tied to a field shows on that field.
  const shownErrors = saveError?.field
    ? { ...errors, [saveError.field]: saveError.message }
    : errors;

  const goTo = (target: StepId) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('step', target);
      return next;
    });

  const next = () => {
    const found = validateStep(state, step, context);
    setErrors(found);
    if (Object.keys(found).length) {
      requestAnimationFrame(() =>
        document
          .querySelector('[role="alert"]')
          ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      );
      return;
    }
    const target = steps[index + 1];
    if (!target) {
      const all = steps.reduce<Errors>(
        (found, id) => ({ ...found, ...validateStep(state, id, context) }),
        {}
      );
      setErrors(all);
      if (!Object.keys(all).length) onSave(state);
      return;
    }
    if (
      target === 'review' &&
      !state.nameEdited &&
      !state.name.trim() &&
      isTriggerStart(state.start)
    )
      setState((current) => ({
        ...current,
        name: titleFromPrompt(current.action.prompt, whenSentence(current)),
      }));
    goTo(target);
  };

  const leave = () => (dirty ? setConfirmLeave(true) : navigate(closeTo));
  const previous = steps[index - 1];
  const back = () => (previous ? goTo(previous) : leave());

  const body: ReactNode =
    step === 'start' ? (
      <StepStart
        value={state.start}
        onChange={(start) => setState((current) => ({ ...current, start }))}
      />
    ) : step === 'when' ? (
      <StepWhen state={state} onChange={setState} errors={shownErrors} />
    ) : step === 'what' ? (
      <StepWhat
        state={state}
        onChange={setState}
        errors={shownErrors}
        lookups={lookups}
        lockedNote={lockedNote}
      />
    ) : (
      <StepReview
        state={state}
        onChange={setState}
        errors={shownErrors}
        lookups={lookups}
        saveError={saveError && !saveError.field ? saveError.message : null}
      />
    );

  const text = STEP_TEXT[step];
  const stepTitle =
    step === 'when' && state.start ? (WHEN_TITLES[state.start] ?? text.title) : text.title;
  const footer = (
    <div
      className={
        isMobile
          ? 'sticky bottom-0 z-10 -mx-3 flex items-center justify-between gap-3 border-0 border-t border-solid border-border-default bg-canvas px-3 py-3'
          : 'flex items-center justify-between gap-3 border-0 border-t border-solid border-border-default pt-5'
      }
    >
      <Button variant="ghost" onClick={back} disabled={saving}>
        {index > 0 ? 'Back' : 'Cancel'}
      </Button>
      <Button onClick={next} loading={saving} data-testid="automation-editor-next">
        {index < steps.length - 1 ? 'Continue' : submitLabel}
      </Button>
    </div>
  );

  const heading = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="m-0 min-w-0 break-words text-[22px] font-bold text-fg-primary [overflow-wrap:anywhere]">
          {title}
        </h1>
        <button
          type="button"
          aria-label="Close"
          onClick={leave}
          className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary"
        >
          <X size={20} aria-hidden />
        </button>
      </div>
      {steps.length > 1 && (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-fg-muted">
            Step {index + 1} of {steps.length} · {text.label}
          </span>
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
            aria-hidden
          >
            {steps.map((id, position) => (
              <span
                key={id}
                className={`h-1.5 rounded-full ${position <= index ? 'bg-accent' : 'bg-surface-hover'}`}
              />
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[18px] font-semibold text-fg-primary">{stepTitle}</h2>
        <p className="m-0 text-sm text-fg-muted">{text.hint}</p>
      </div>
    </div>
  );

  const content = (
    <div className="flex min-w-0 flex-col gap-6" data-testid="automation-editor">
      {heading}
      {body}
      {footer}
    </div>
  );

  return (
    <>
      {isMobile ? (
        <Page>{content}</Page>
      ) : (
        <Page wide>
          <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            {content}
            <aside className="sticky top-8 hidden flex-col gap-3 lg:flex" aria-label="Preview">
              <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
                Preview
              </span>
              <Panel className="flex flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  {state.start && (
                    <KindIcon start={state.start === 'incident' ? 'incident' : state.start} />
                  )}
                  <span className="min-w-0 break-words text-[15px] font-semibold text-fg-primary">
                    {state.name.trim() || 'New automation'}
                  </span>
                </div>
                <p className="m-0 text-sm leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
                  {state.start ? whenSentence(state) : 'Pick what starts it.'}
                </p>
              </Panel>
              <p className="m-0 text-[13px] text-fg-muted">
                Nothing is saved until you press “{submitLabel}”.
              </p>
            </aside>
          </div>
        </Page>
      )}
      <ConfirmDialog
        isOpen={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          navigate(closeTo);
        }}
        title="Discard your changes?"
        message="Nothing you changed here has been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="warning"
      />
    </>
  );
}
