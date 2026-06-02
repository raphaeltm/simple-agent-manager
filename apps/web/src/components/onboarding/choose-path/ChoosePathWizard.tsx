/**
 * Choose-Your-Path Onboarding Wizard
 *
 * Replaces the old tab-based onboarding with a question-driven flow:
 * 1. Questions → user picks their AI subscription, cloud, GitHub status
 * 2. Path Preview → personalized setup plan based on answers
 * 3. Step Execution → real API calls for each setup step
 * 4. Completion → success screen with next-steps guidance
 *
 * Inspired by TurboTax's question-driven flow and Vercel's guided import.
 */
import { Card } from '@simple-agent-manager/ui';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  getTrialStatus,
  listAgentCredentials,
  listCredentials,
  listGitHubInstallations,
} from '../../../lib/api';
import { useAuth } from '../../AuthProvider';
import { CompletionScreen } from './CompletionScreen';
import { generatePath, type GeneratedStep } from './path-generator';
import { PathPreview } from './PathPreview';
import { QuestionCard } from './QuestionCard';
import { QUESTIONS, type PathOption } from './questions';
import { StepExecution } from './StepExecution';

type Phase = 'questions' | 'path-preview' | 'executing' | 'complete';

function getStorageKey(userId: string): string {
  return `sam-onboarding-wizard-dismissed-${userId}`;
}

export function ChoosePathWizard() {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [setupComplete, setSetupComplete] = useState(false);

  const [phase, setPhase] = useState<Phase>('questions');
  const [currentQuestionId, setCurrentQuestionId] = useState('ai-subscription');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [generatedSteps, setGeneratedSteps] = useState<GeneratedStep[]>([]);

  // Check dismissal state
  useEffect(() => {
    if (!userId) return;
    const stored = localStorage.getItem(getStorageKey(userId));
    setDismissed(stored === 'true');
  }, [userId]);

  // Check existing setup status
  useEffect(() => {
    async function checkStatus() {
      try {
        const [credentials, installations, agentCreds, trialStatus] = await Promise.all([
          listCredentials(),
          listGitHubInstallations(),
          listAgentCredentials(),
          getTrialStatus().catch(() => null),
        ]);

        const hasCloud = credentials.some(
          (c) => c.provider === 'hetzner' || c.provider === 'scaleway'
        );
        const hasGitHub = installations.length > 0;
        const hasAgent = agentCreds.credentials.some((c) => c.isActive);
        const trialAvailable = trialStatus?.available ?? false;

        // If fully set up, auto-dismiss
        if (hasAgent && hasCloud && hasGitHub) {
          setSetupComplete(true);
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
        setLoading(false);
      }
    }
    checkStatus();
  }, [userId]);

  const handleDismiss = useCallback(() => {
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
    setDismissed(true);
  }, [userId]);

  const handleAnswer = useCallback(
    (option: PathOption) => {
      setAnswers((prev) => ({ ...prev, [currentQuestionId]: option.id }));
      setTags((prev) => {
        const newTags = [...prev, ...option.tags];
        if (!option.next) {
          const steps = generatePath(newTags);
          setGeneratedSteps(steps);
          setPhase('path-preview');
        }
        return newTags;
      });

      if (option.next) {
        setCurrentQuestionId(option.next);
      }
    },
    [currentQuestionId]
  );

  const handleReset = useCallback(() => {
    setPhase('questions');
    setCurrentQuestionId('ai-subscription');
    setAnswers({});
    // Keep existing-* tags, clear user answers
    setTags((prev) => prev.filter((t) => t.startsWith('existing-')));
    setGeneratedSteps([]);
  }, []);

  // Back navigation in questions
  const questionHistory = Object.keys(answers);
  const canGoBack = questionHistory.length > 0 && phase === 'questions';

  const handleBack = useCallback(() => {
    if (questionHistory.length === 0) return;
    const lastAnsweredId = questionHistory[questionHistory.length - 1] as string;
    const lastAnswer = answers[lastAnsweredId] as string | undefined;
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
  }, [answers, questionHistory, tags]);

  const handleExecutionComplete = useCallback(() => {
    setPhase('complete');
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
  }, [userId]);

  // Don't render while loading or if dismissed
  if (loading || dismissed === null || dismissed || setupComplete) return null;

  const currentQuestion = QUESTIONS.find((q) => q.id === currentQuestionId);

  return (
    <div data-testid="onboarding-wizard" aria-label="Account setup" className="mb-6">
      <Card className="p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default bg-surface">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-accent/20 flex items-center justify-center text-accent text-xs font-bold">
              S
            </div>
            <span className="text-sm font-semibold text-fg-primary">Setup</span>
          </div>
          <div className="flex items-center gap-2">
            {canGoBack && (
              <button
                type="button"
                onClick={handleBack}
                className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer"
              >
                <ArrowLeft size={12} /> Back
              </button>
            )}
            {phase === 'questions' && (
              <span className="text-xs text-fg-muted/50">
                Q{Object.keys(answers).length + 1} of ~{QUESTIONS.length}
              </span>
            )}
            {phase === 'path-preview' && (
              <span className="text-xs text-fg-muted/50">Your plan</span>
            )}
            {phase === 'executing' && (
              <span className="text-xs text-fg-muted/50">Setting up...</span>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0"
            >
              Skip setup
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 py-6">
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
              tags={tags.filter((t) => !t.startsWith('existing-'))}
              onStart={() => setPhase('executing')}
              onReset={handleReset}
            />
          )}
          {phase === 'executing' && (
            <StepExecution
              steps={generatedSteps}
              tags={tags}
              onComplete={handleExecutionComplete}
            />
          )}
          {phase === 'complete' && <CompletionScreen />}
        </div>
      </Card>
    </div>
  );
}
