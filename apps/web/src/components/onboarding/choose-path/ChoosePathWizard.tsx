/**
 * First-run onboarding: SAM introduces itself, asks only what this installation leaves open,
 * walks the user through the steps that remain, and hands off to their first chat.
 *
 * A full-screen SAM Glass overlay: the void, one frosted pane, SAM's head as the host.
 */
import { Button, Pane } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { useSetupStatus } from '../../../hooks/useSetupStatus';
import { useTrialStatus } from '../../../hooks/useTrialStatus';
import {
  projectArtifactsEnabledQueryOptions,
  projectListQueryOptions,
} from '../../../lib/query-options';
import { SamHero } from '../../SamHero';
import { useOnboarding } from '../OnboardingContext';
import { CompletionScreen } from './CompletionScreen';
import { type GeneratedStep, generatePath } from './path-generator';
import { QuestionCard } from './QuestionCard';
import {
  type Answers,
  openQuestions,
  presetAnswers,
  type Question,
  type SetupContext,
} from './questions';
import { StepExecution } from './StepExecution';
import { useWizardKeyboard } from './useWizardKeyboard';

type Phase = 'hello' | 'questions' | 'steps' | 'done';

export function ChoosePathWizard() {
  const { showOverlay, dismissOnboarding } = useOnboarding();
  const queryScope = useQueryScope();
  const setup = useSetupStatus(queryScope);
  const trial = useTrialStatus(showOverlay ? queryScope : '');
  // SAM-hosted repositories (Cloudflare Artifacts) are offered only where this installation has
  // them; everywhere else the repository question is about GitHub.
  const artifactsQuery = useQuery({
    ...projectArtifactsEnabledQueryOptions(queryScope),
    enabled: Boolean(queryScope) && showOverlay,
  });

  // Setup status reads projects only when GitHub is not connected; the wizard needs to know
  // either way, so it does not create a second first project.
  const projectsQuery = useQuery({
    ...projectListQueryOptions(queryScope, 1),
    enabled: Boolean(queryScope) && showOverlay,
  });
  const hasProject = setup.hasProject || (projectsQuery.data ?? []).length > 0;

  const [phase, setPhase] = useState<Phase>('hello');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [steps, setSteps] = useState<GeneratedStep[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useWizardKeyboard({
    active: showOverlay,
    dialogRef,
    contentRef,
    onEscape: dismissOnboarding,
  });

  // Focus the screen's heading whenever the screen changes, so keyboard and screen-reader users
  // start inside the overlay and stay there as screens swap out under them.
  const headingRef = useCallback(
    (el: HTMLHeadingElement | null) => el?.focus(),
    [phase, questionIndex] // eslint-disable-line react-hooks/exhaustive-deps -- re-created per screen so React re-focuses
  );
  useEffect(() => {
    if (showOverlay) requestAnimationFrame(() => contentRef.current?.focus());
  }, [showOverlay]);

  const context: SetupContext = useMemo(
    () => ({
      instantEnabled: setup.instantEnabled,
      platformCompute: setup.platformCompute,
      artifactsEnabled: artifactsQuery.data === true,
      hasCloud: setup.hasCloud,
      hasGitHub: setup.hasGitHub,
    }),
    [
      setup.instantEnabled,
      setup.platformCompute,
      setup.hasCloud,
      setup.hasGitHub,
      artifactsQuery.data,
    ]
  );
  // The questions depend on what the installation offers; wait for those reads to settle.
  const contextReady = !setup.loading && !artifactsQuery.isLoading && !projectsQuery.isLoading;

  const startSteps = useCallback(
    (finalAnswers: Answers) => {
      setAnswers(finalAnswers);
      setSteps(
        generatePath(finalAnswers, {
          hasAgent: setup.hasAgent,
          hasCloud: setup.hasCloud,
          hasGitHub: setup.hasGitHub,
          hasProject,
        })
      );
      setPhase('steps');
    },
    [setup.hasAgent, setup.hasCloud, setup.hasGitHub, hasProject]
  );

  const begin = useCallback(() => {
    const open = openQuestions(context);
    const preset = presetAnswers(context);
    setQuestions(open);
    setQuestionIndex(0);
    setAnswers(preset);
    if (open.length > 0) setPhase('questions');
    else startSteps(preset);
  }, [context, startSteps]);

  const answer = useCallback(
    (choiceId: string) => {
      const question = questions[questionIndex];
      if (!question) return;
      const next = { ...answers, [question.id]: choiceId } as Answers;
      setAnswers(next);
      if (questionIndex < questions.length - 1) setQuestionIndex((i) => i + 1);
      else startSteps(next);
    },
    [answers, questions, questionIndex, startSteps]
  );

  const back = useCallback(() => {
    if (phase === 'steps') {
      if (questions.length === 0) setPhase('hello');
      else {
        setQuestionIndex(questions.length - 1);
        setPhase('questions');
      }
    } else if (phase === 'questions') {
      if (questionIndex === 0) setPhase('hello');
      else setQuestionIndex((i) => i - 1);
    }
  }, [phase, questions.length, questionIndex]);

  const finish = useCallback((createdProjectId: string | null) => {
    setProjectId(createdProjectId);
    setPhase('done');
  }, []);

  if (!showOverlay) return null;

  const question = questions[questionIndex];
  const canGoBack = phase === 'questions' || phase === 'steps';

  return (
    <div
      ref={dialogRef}
      data-testid="onboarding-wizard"
      role="dialog"
      aria-label="Set up SAM"
      aria-modal="true"
      className="sam-void fixed inset-0 z-50 flex flex-col text-fg-primary"
    >
      <div className="flex items-center justify-between px-3 pt-[max(env(safe-area-inset-top),0.75rem)] sm:px-5">
        {canGoBack ? (
          <button
            type="button"
            onClick={back}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-2 text-sm text-fg-muted transition-colors hover:text-fg-primary"
          >
            <ArrowLeft size={16} aria-hidden="true" /> Back
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={dismissOnboarding}
          aria-label="Close setup"
          className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-fg-muted transition-colors hover:text-fg-primary"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div
        ref={contentRef}
        tabIndex={-1}
        className="relative flex-1 overflow-y-auto overflow-x-hidden px-4 pb-[max(env(safe-area-inset-bottom),2rem)] outline-none"
      >
        <div className="mx-auto flex min-h-full w-full min-w-0 max-w-[36rem] flex-col justify-center py-4 sm:py-10">
          <Pane className="w-full min-w-0 px-5 py-7 sm:px-9 sm:py-9">
            {phase === 'hello' && (
              <Hello
                headingRef={headingRef}
                ready={contextReady}
                onBegin={begin}
                onLater={dismissOnboarding}
              />
            )}
            {phase === 'questions' && question && (
              <QuestionCard
                question={question}
                selectedId={answers[question.id] ?? null}
                onSelect={answer}
                headingRef={headingRef}
              />
            )}
            {phase === 'steps' && (
              <StepExecution
                steps={steps}
                runtime={answers.runtime}
                hostedRepo={answers.repo === 'hosted'}
                samAvailable={trial.trial?.hasAgentCredential === true}
                onComplete={finish}
              />
            )}
            {phase === 'done' && (
              <CompletionScreen projectId={projectId} onDismiss={dismissOnboarding} />
            )}
          </Pane>
        </div>
      </div>
    </div>
  );
}

function Hello({
  headingRef,
  ready,
  onBegin,
  onLater,
}: {
  headingRef: (el: HTMLHeadingElement | null) => void;
  ready: boolean;
  onBegin: () => void;
  onLater: () => void;
}) {
  return (
    <div className="text-center">
      <SamHero />
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-[1.6rem] font-bold leading-tight outline-none sm:text-[1.9rem]"
      >
        Hi, I&apos;m SAM.
      </h2>
      <p className="mx-auto mb-7 mt-2 max-w-sm text-[0.95rem] text-fg-muted">
        I run coding agents for you, each in its own workspace. A couple of questions and
        you&apos;ll be chatting with one in a few minutes.
      </p>
      <Button
        variant="accent"
        size="lg"
        className="w-full sm:w-auto"
        onClick={onBegin}
        disabled={!ready}
      >
        {ready ? (
          <>
            Let&apos;s get you set up
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </>
        ) : (
          <>
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            Checking what&apos;s here
          </>
        )}
      </Button>
      <div>
        <button
          type="button"
          onClick={onLater}
          className="mt-3 min-h-11 cursor-pointer border-0 bg-transparent px-2 text-sm text-fg-muted hover:text-fg-primary"
        >
          I&apos;ll look around first
        </button>
      </div>
    </div>
  );
}
