/**
 * Choose-Your-Path Onboarding Wizard
 *
 * Replaces the old tab-based onboarding with a question-driven flow:
 * 1. Questions -> user picks their AI subscription, cloud, GitHub status
 * 2. Path Preview -> personalized setup plan based on answers
 * 3. Step Execution -> real API calls for each setup step
 * 4. Completion -> success screen with next-steps guidance
 */
import { Card, SkeletonCard } from '@simple-agent-manager/ui';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getTrialStatus,
  listAgentCredentials,
  listCredentials,
  listGitHubInstallations,
} from '../../../lib/api';
import { useAuth } from '../../AuthProvider';
import { CompletionScreen } from './CompletionScreen';
import { type GeneratedStep, generatePath } from './path-generator';
import { PathPreview } from './PathPreview';
import { QuestionCard } from './QuestionCard';
import { type PathOption, QUESTIONS } from './questions';
import { StepExecution } from './StepExecution';

type Phase = 'questions' | 'path-preview' | 'executing' | 'complete';

const PHASE_LABELS: Record<Phase, string> = {
  questions: '',
  'path-preview': 'Your personalized setup plan is ready',
  executing: 'Setting up your account',
  complete: 'Setup complete!',
};

function getStorageKey(userId: string): string {
  return `sam-onboarding-wizard-dismissed-${userId}`;
}

export function ChoosePathWizard() {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<boolean | null>(() => {
    if (!userId) return null;
    return localStorage.getItem(getStorageKey(userId)) === 'true';
  });

  const [phase, setPhase] = useState<Phase>('questions');
  const [currentQuestionId, setCurrentQuestionId] = useState('ai-subscription');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [generatedSteps, setGeneratedSteps] = useState<GeneratedStep[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  // Ref keeps latest tags accessible in callbacks without stale closures
  const tagsRef = useRef(tags);
  tagsRef.current = tags;

  const focusContent = useCallback(
    () => requestAnimationFrame(() => contentRef.current?.focus()),
    []
  );

  // Check existing setup status (async data fetch — genuine useEffect)
  useEffect(() => {
    const controller = new AbortController();
    async function checkStatus() {
      try {
        const [credResult, installResult, agentResult, trialResult] = await Promise.allSettled([
          listCredentials(),
          listGitHubInstallations(),
          listAgentCredentials(),
          getTrialStatus(),
        ]);
        if (controller.signal.aborted) return;

        const credentials = credResult.status === 'fulfilled' ? credResult.value : [];
        const installations = installResult.status === 'fulfilled' ? installResult.value : [];
        const agentCreds = agentResult.status === 'fulfilled' ? agentResult.value : { credentials: [] };
        const trialStatus = trialResult.status === 'fulfilled' ? trialResult.value : null;

        const hasCloud = credentials.some(
          (c) => c.provider === 'hetzner' || c.provider === 'scaleway'
        );
        const hasGitHub = installations.length > 0;
        const hasAgent = agentCreds.credentials.some((c) => c.isActive);
        const trialAvailable = trialStatus?.available ?? false;

        // If fully set up, auto-dismiss
        if (hasAgent && hasCloud && hasGitHub) {
          setDismissed(true);
          if (userId) localStorage.setItem(getStorageKey(userId), 'true');
        }

        // Pre-populate tags based on existing setup so the path skips completed steps
        const existingTags: string[] = [];
        if (hasAgent || trialAvailable) existingTags.push('existing-agent');
        if (hasCloud || trialAvailable) existingTags.push('existing-cloud');
        if (hasGitHub) existingTags.push('existing-github');

        if (existingTags.length > 0) {
          setTags((prev) => [...new Set([...prev, ...existingTags])]);
        }
      } catch {
        // Non-critical
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    checkStatus();
    return () => controller.abort();
  }, [userId]);

  const handleDismiss = useCallback(() => {
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
    setDismissed(true);
  }, [userId]);

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
    [currentQuestionId]
  );

  const handleReset = useCallback(() => {
    setPhase('questions');
    setCurrentQuestionId('ai-subscription');
    setAnswers({});
    setTags((prev) => prev.filter((t) => t.startsWith('existing-')));
    setGeneratedSteps([]);
  }, []);

  // Back navigation in questions
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
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
    focusContent();
  }, [userId]);

  // Filter out auto-handled steps for execution
  const executableSteps = useMemo(
    () => generatedSteps.filter((s) => !s.isOptional),
    [generatedSteps]
  );

  // Show skeleton during initial load
  if (loading || dismissed === null) {
    return (
      <div className="mb-6">
        <SkeletonCard lines={2} />
      </div>
    );
  }

  if (dismissed) return null;

  const currentQuestion = QUESTIONS.find((q) => q.id === currentQuestionId);
  const liveAnnouncement =
    phase === 'questions'
      ? currentQuestion?.question ?? ''
      : PHASE_LABELS[phase];

  return (
    <div data-testid="onboarding-wizard" role="region" aria-label="Account setup" className="mb-6">
      {/* Screen reader announcement for phase transitions */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      <Card className="p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default bg-surface">
          <div className="flex items-center gap-2">
            <div aria-hidden="true" className="w-6 h-6 rounded-md bg-accent/20 flex items-center justify-center text-accent text-xs font-bold">
              S
            </div>
            <span className="text-sm font-semibold text-fg-primary">Setup</span>
          </div>
          <div className="flex items-center gap-3">
            {canGoBack && (
              <button
                type="button"
                onClick={handleBack}
                className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer min-h-[44px]"
              >
                <ArrowLeft size={12} aria-hidden="true" /> Back
              </button>
            )}
            {phase === 'questions' && (
              <span className="text-xs text-fg-muted">
                Q{Object.keys(answers).length + 1}
              </span>
            )}
            {phase === 'path-preview' && (
              <span className="text-xs text-fg-muted">Your plan</span>
            )}
            {phase === 'executing' && (
              <span className="text-xs text-fg-muted">Setting up...</span>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer min-h-[44px] px-1"
            >
              Skip setup
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={contentRef} tabIndex={-1} className="p-4 py-6 outline-none">
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
              tags={tags}
              onComplete={handleExecutionComplete}
              onDismiss={handleDismiss}
            />
          )}
          {phase === 'complete' && <CompletionScreen onDismiss={handleDismiss} />}
        </div>
      </Card>
    </div>
  );
}
