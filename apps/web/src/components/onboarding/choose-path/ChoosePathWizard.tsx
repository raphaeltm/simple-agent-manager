/**
 * Choose-Your-Path Onboarding Wizard — Full-Screen Overlay
 *
 * Renders as a fixed overlay with a green-glow vignette background.
 * The standard app UI is hidden behind it. Users dismiss via X button.
 */
import { hasByocComputeCredential } from '@simple-agent-manager/shared';
import { ArrowLeft, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  listAgentCredentials,
  listCredentials,
  listGitHubInstallations,
} from '../../../lib/api';
import { useOnboarding } from '../OnboardingContext';
import { CompletionScreen } from './CompletionScreen';
import { type GeneratedStep, generatePath } from './path-generator';
import { PathPreview } from './PathPreview';
import { QuestionCard } from './QuestionCard';
import { type PathOption, QUESTIONS } from './questions';
import { StepExecution } from './StepExecution';

type Phase = 'questions' | 'path-preview' | 'executing' | 'complete';

export function ChoosePathWizard() {
  const { showOverlay, dismissOnboarding } = useOnboarding();

  const [phase, setPhase] = useState<Phase>('questions');
  const [currentQuestionId, setCurrentQuestionId] = useState('cloud-account');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [generatedSteps, setGeneratedSteps] = useState<GeneratedStep[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tagsRef = useRef(tags);
  tagsRef.current = tags;

  const focusContent = useCallback(
    () => requestAnimationFrame(() => contentRef.current?.focus()),
    []
  );

  // H2: move focus into the dialog when it opens — and again on every step
  // change — so keyboard/screen-reader users start inside the overlay and stay
  // there. Clicking an option unmounts the focused button; without re-focusing
  // the content region, focus falls back to <body> and the Escape-close and
  // Tab focus-trap (handleKeyDown) stop firing for the rest of the wizard.
  useEffect(() => {
    if (showOverlay) focusContent();
  }, [showOverlay, phase, currentQuestionId, focusContent]);

  // H1 + H3: Escape closes the dialog; Tab is trapped within the overlay so
  // focus cannot escape to the hidden app UI behind it (WCAG 2.1.2 / 2.4.3).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissOnboarding();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || active === contentRef.current) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dismissOnboarding]
  );

  // Pre-populate tags from existing setup state
  useEffect(() => {
    const controller = new AbortController();
    async function checkExisting() {
      try {
        const [credResult, installResult, agentResult] = await Promise.allSettled([
          listCredentials(),
          listGitHubInstallations(),
          listAgentCredentials(),
        ]);
        if (controller.signal.aborted) return;

        const credentials = credResult.status === 'fulfilled' ? credResult.value : [];
        const installations = installResult.status === 'fulfilled' ? installResult.value : [];
        const agentCreds = agentResult.status === 'fulfilled' ? agentResult.value : { credentials: [] };

        const hasCloud = hasByocComputeCredential(credentials);
        const hasGitHub = installations.length > 0;
        const hasAgent = agentCreds.credentials.some((c) => c.isActive);

        // Pre-mark a step as already-done only when the user has configured their
        // OWN credential. Platform availability (SAM-managed AI / infra) is a choice
        // the user still makes inside the flow — it must not skip the question.
        const existingTags: string[] = [];
        if (hasAgent) existingTags.push('existing-agent');
        if (hasCloud) existingTags.push('existing-cloud');
        if (hasGitHub) existingTags.push('existing-github');

        if (existingTags.length > 0) {
          setTags((prev) => [...new Set([...prev, ...existingTags])]);
        }
      } catch {
        // Non-critical
      }
    }
    checkExisting();
    return () => controller.abort();
  }, []);

  const handleAnswer = useCallback(
    (option: PathOption) => {
      setAnswers((prev) => ({ ...prev, [currentQuestionId]: option.id }));
      const newTags = [...tagsRef.current, ...option.tags];
      setTags(newTags);

      if (option.next) {
        setCurrentQuestionId(option.next);
      } else {
        setGeneratedSteps(generatePath(newTags));
        setPhase('path-preview');
        focusContent();
      }
    },
    [currentQuestionId, focusContent]
  );

  const handleReset = useCallback(() => {
    setPhase('questions');
    setCurrentQuestionId('cloud-account');
    setAnswers({});
    setTags((prev) => prev.filter((t) => t.startsWith('existing-')));
    setGeneratedSteps([]);
  }, []);

  const questionHistory = Object.keys(answers);
  const canGoBack = questionHistory.length > 0 && phase === 'questions';

  const handleBack = useCallback(() => {
    const lastAnsweredId = questionHistory.at(-1);
    if (!lastAnsweredId) return;
    const lastAnswer = answers[lastAnsweredId];
    const lastOption = QUESTIONS.find((q) => q.id === lastAnsweredId)?.options.find(
      (o) => o.id === lastAnswer
    );

    const newAnswers = { ...answers };
    delete newAnswers[lastAnsweredId];
    setAnswers(newAnswers);

    if (lastOption) {
      setTags((prev) => prev.filter((t) => !lastOption.tags.includes(t)));
    }
    setCurrentQuestionId(lastAnsweredId);
  }, [answers, questionHistory]);

  const handleExecutionComplete = useCallback(() => {
    setPhase('complete');
    focusContent();
  }, [focusContent]);

  const executableSteps = useMemo(
    () => generatedSteps.filter((s) => !s.isOptional),
    [generatedSteps]
  );

  if (!showOverlay) return null;

  const currentQuestion = QUESTIONS.find((q) => q.id === currentQuestionId);

  return (
    <div
      ref={dialogRef}
      onKeyDown={handleKeyDown}
      data-testid="onboarding-wizard"
      role="dialog"
      aria-label="Account setup"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--sam-onboarding-overlay-bg)' }}
    >
      {/* Screen reader announcement */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {phase === 'questions' ? currentQuestion?.question ?? '' : ''}
      </div>

      {/* Top bar — X dismiss + back nav */}
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          {canGoBack && (
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer min-h-[44px] transition-colors"
            >
              <ArrowLeft size={16} /> Back
            </button>
          )}
          {phase === 'questions' && (
            <span className="text-xs text-fg-muted/60">
              Question {Object.keys(answers).length + 1}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={dismissOnboarding}
          aria-label="Exit setup"
          className="inline-flex items-center justify-center w-11 h-11 rounded-full text-fg-muted hover:text-fg-primary hover:bg-fg-primary/5 bg-transparent border-none cursor-pointer transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Scrollable content area — centered */}
      <div
        ref={contentRef}
        tabIndex={-1}
        className="flex-1 overflow-y-auto overflow-x-hidden outline-none px-4 pb-8 sm:px-6"
      >
        <div className="max-w-lg mx-auto pt-4 sm:pt-12">
          {phase === 'questions' && currentQuestion && (
            <QuestionCard
              question={currentQuestion}
              selectedId={answers[currentQuestionId] ?? null}
              onSelect={handleAnswer}
            />
          )}
          {phase === 'path-preview' && (
            <PathPreview
              steps={generatedSteps}
              onStart={() => {
                setPhase('executing');
                focusContent();
              }}
              onReset={handleReset}
            />
          )}
          {phase === 'executing' && (
            <StepExecution
              steps={executableSteps}
              onComplete={handleExecutionComplete}
            />
          )}
          {phase === 'complete' && <CompletionScreen onDismiss={dismissOnboarding} />}
        </div>
      </div>
    </div>
  );
}
