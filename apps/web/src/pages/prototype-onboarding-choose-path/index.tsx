/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 *
 * Choose-Your-Path Onboarding Prototype
 *
 * This prototype asks 2-4 quick questions about what the user already has
 * (AI subscription, cloud account, GitHub repo) and generates a personalized
 * setup path. Each step shows ONLY what's relevant to that user.
 *
 * Key insight from user interviews: users are confused because they see ALL
 * options (3 billing modes, 3 cloud providers, multiple agents) when they
 * only need ONE path. This prototype eliminates irrelevant options.
 *
 * Inspired by: TurboTax's question-driven flow, Vercel's guided import.
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import {
  generatePath,
  getTimeEstimate,
  QUESTIONS,
  type GeneratedStep,
  type PathOption,
  type PathQuestion,
} from './mock-data';

/* ─── shared styles ─── */
const glass =
  'bg-[rgba(8,15,12,0.65)] backdrop-blur-[24px] backdrop-saturate-[1.35] border border-[rgba(34,197,94,0.12)] rounded-[10px]';
const btn =
  'inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-[8px] font-medium text-sm transition-all cursor-pointer border-none';
const btnPrimary = `${btn} bg-green-600 hover:bg-green-700 text-white`;
const btnGhost = `${btn} bg-transparent hover:bg-white/5 text-[#9fb7ae]`;

type Phase = 'questions' | 'path-preview' | 'executing';

/* ─── Question Card ─── */
function QuestionCard({
  question,
  onSelect,
  selectedId,
}: {
  question: PathQuestion;
  onSelect: (option: PathOption) => void;
  selectedId: string | null;
}) {
  return (
    <div className="max-w-md mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">{question.question}</h2>
      <p className="text-sm text-[#9fb7ae] mb-6">{question.description}</p>

      <div className="space-y-3">
        {question.options.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option)}
            className={`w-full text-left p-4 rounded-[10px] border transition-all cursor-pointer group ${
              selectedId === option.id
                ? 'bg-[rgba(34,197,94,0.1)] border-green-500/40'
                : 'bg-[rgba(8,15,12,0.65)] border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.25)]'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[rgba(34,197,94,0.08)] flex items-center justify-center text-lg flex-shrink-0">
                {option.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[#e6f2ee]">{option.label}</span>
                  {selectedId === option.id ? (
                    <Check size={16} className="text-green-400" />
                  ) : (
                    <ChevronRight
                      size={14}
                      className="text-[#9fb7ae]/20 group-hover:text-[#9fb7ae]/50 transition-colors"
                    />
                  )}
                </div>
                <p className="text-sm text-[#9fb7ae] mt-0.5">{option.description}</p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Path Preview ─── */
function PathPreview({
  steps,
  tags,
  onStart,
  onReset,
}: {
  steps: GeneratedStep[];
  tags: string[];
  onStart: () => void;
  onReset: () => void;
}) {
  const timeEstimate = getTimeEstimate(steps);
  const requiredSteps = steps.filter((s) => !s.isOptional);

  return (
    <div className="max-w-md mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
          <Sparkles size={28} className="text-green-400" />
        </div>
        <h2 className="text-2xl font-bold text-[#e6f2ee] mb-2">Your personalized setup path</h2>
        <p className="text-sm text-[#9fb7ae] mb-1">
          Based on your answers, here's what you need to do:
        </p>
        <div className="flex items-center justify-center gap-3 text-xs text-[#9fb7ae]/60 mt-2">
          <span className="flex items-center gap-1">
            <Clock size={12} /> {timeEstimate} total
          </span>
          <span>|</span>
          <span>{requiredSteps.length} steps</span>
          {steps.length > requiredSteps.length && (
            <>
              <span>|</span>
              <span>{steps.length - requiredSteps.length} already handled</span>
            </>
          )}
        </div>
      </div>

      {/* Step list */}
      <div className="space-y-3 mb-8">
        {steps.map((step, i) => (
          <div
            key={step.id}
            className={`${glass} p-4 ${step.isOptional ? 'opacity-60' : ''}`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  step.isOptional
                    ? 'bg-green-500/10 text-green-400'
                    : 'bg-green-500/20 text-green-400'
                }`}
              >
                {step.isOptional ? <Check size={12} /> : i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-[#e6f2ee] text-sm">{step.title}</span>
                  <span className="text-[10px] text-[#9fb7ae]/40">{step.timeEstimate}</span>
                  {step.isOptional && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
                      Done
                    </span>
                  )}
                </div>
                <p className="text-xs text-[#9fb7ae]">{step.description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-col items-center gap-3">
        <button onClick={onStart} className={`${btnPrimary} w-full max-w-xs`}>
          <Play size={14} /> Start setup ({timeEstimate})
        </button>
        <button onClick={onReset} className={btnGhost}>
          <RotateCcw size={14} /> Change my answers
        </button>
      </div>

      {/* What you told us */}
      <div className="mt-8 text-center">
        <p className="text-[10px] text-[#9fb7ae]/30 mb-1">Your profile:</p>
        <div className="flex flex-wrap gap-1 justify-center">
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(34,197,94,0.06)] text-[#9fb7ae]/40"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Step Execution ─── */
function StepExecution({
  steps,
  onComplete,
}: {
  steps: GeneratedStep[];
  onComplete: () => void;
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const step = steps[currentStepIndex];
  const isLast = currentStepIndex >= steps.length - 1;
  const progress = ((completedSteps.length) / steps.length) * 100;

  const handleAction = useCallback(() => {
    setSimulating(true);
    setTimeout(() => {
      setSimulating(false);
      setCompletedSteps((prev) => [...prev, step.id]);
      if (isLast) {
        setTimeout(onComplete, 500);
      } else {
        setCurrentStepIndex((i) => i + 1);
        setExpandedDetails(false);
      }
    }, 1500);
  }, [step, isLast, onComplete]);

  const handleSkip = useCallback(() => {
    setCompletedSteps((prev) => [...prev, step.id]);
    if (isLast) {
      onComplete();
    } else {
      setCurrentStepIndex((i) => i + 1);
      setExpandedDetails(false);
    }
  }, [step, isLast, onComplete]);

  return (
    <div className="max-w-md mx-auto">
      {/* Progress header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[#9fb7ae]/60">
            Step {currentStepIndex + 1} of {steps.length}
          </span>
          <span className="text-xs text-[#9fb7ae]/60">
            {Math.round(progress)}% complete
          </span>
        </div>
        <div className="w-full h-1.5 bg-[rgba(34,197,94,0.1)] rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Step indicator pills */}
        <div className="flex gap-1 mt-2">
          {steps.map((s, i) => (
            <div
              key={s.id}
              className={`h-1 flex-1 rounded-full transition-all ${
                completedSteps.includes(s.id)
                  ? 'bg-green-500'
                  : i === currentStepIndex
                    ? 'bg-green-500/50'
                    : 'bg-[rgba(34,197,94,0.1)]'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Current step */}
      <div className={`${glass} p-6 mb-4`}>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center text-xs font-bold text-green-400">
            {currentStepIndex + 1}
          </div>
          <h3 className="text-lg font-semibold text-[#e6f2ee]">{step.title}</h3>
        </div>
        <p className="text-sm text-[#9fb7ae] mb-4 ml-9">{step.description}</p>

        {/* Action area */}
        <div className="ml-9">
          <button
            onClick={handleAction}
            disabled={simulating}
            className={`${btnPrimary} ${simulating ? 'opacity-70' : ''}`}
          >
            {simulating ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Setting up...
              </>
            ) : (
              <>
                {step.action} <ArrowRight size={14} />
              </>
            )}
          </button>

          {step.isOptional && (
            <button onClick={handleSkip} className={`${btnGhost} ml-2`}>
              Skip
            </button>
          )}
        </div>

        {/* Expandable details */}
        <div className="ml-9 mt-4">
          <button
            onClick={() => setExpandedDetails(!expandedDetails)}
            className="flex items-center gap-1 text-xs text-[#9fb7ae]/50 hover:text-[#9fb7ae] transition-colors bg-transparent border-none cursor-pointer"
          >
            <ChevronDown
              size={12}
              className={`transition-transform ${expandedDetails ? 'rotate-180' : ''}`}
            />
            {expandedDetails ? 'Hide' : 'Show'} details
          </button>
          {expandedDetails && (
            <ul className="mt-2 space-y-1.5">
              {step.details.map((detail, i) => (
                <li key={i} className="text-xs text-[#9fb7ae] flex items-start gap-2">
                  <Check size={10} className="text-green-400/50 mt-0.5 flex-shrink-0" />
                  {detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Upcoming steps */}
      {!isLast && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-[#9fb7ae]/30 uppercase tracking-wide font-medium">
            Coming up
          </p>
          {steps.slice(currentStepIndex + 1).map((s, i) => (
            <div
              key={s.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-[#9fb7ae]/40"
            >
              <div className="w-5 h-5 rounded-full bg-[rgba(34,197,94,0.05)] flex items-center justify-center text-[10px]">
                {currentStepIndex + 2 + i}
              </div>
              <span>{s.title}</span>
              <span className="ml-auto text-[10px]">{s.timeEstimate}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Completion Screen ─── */
function CompletionScreen() {
  return (
    <div className="max-w-md mx-auto text-center">
      <div className="mt-8 mb-6">
        <div className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
          <Check size={36} className="text-green-400" />
        </div>
        <h2 className="text-2xl font-bold text-[#e6f2ee] mb-2">You're all set!</h2>
        <p className="text-[#9fb7ae] max-w-sm mx-auto">
          Your account is configured and ready to go. Start a chat in your project to begin.
        </p>
      </div>

      <div className={`${glass} p-5 text-left mb-6`}>
        <p className="text-xs text-[#9fb7ae]/50 uppercase tracking-wide font-medium mb-3">
          What's next
        </p>
        <div className="space-y-3">
          {[
            {
              title: 'Start a chat in your project',
              desc: 'Describe what you want built and the agent will start working',
            },
            {
              title: 'Watch the agent work',
              desc: 'See real-time progress as it edits files, runs tests, and creates PRs',
            },
            {
              title: 'Review and merge',
              desc: 'Check the PR, request changes, or merge it to your main branch',
            },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-green-500/10 flex items-center justify-center text-xs text-green-400 font-bold flex-shrink-0">
                {i + 1}
              </div>
              <div>
                <p className="text-sm font-medium text-[#e6f2ee]">{item.title}</p>
                <p className="text-xs text-[#9fb7ae]">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button className={`${btnPrimary} w-full max-w-xs`}>
        <Sparkles size={14} /> Go to my project
      </button>
      <p className="text-[10px] text-[#9fb7ae]/30 mt-3">
        You can change any setting in Settings anytime
      </p>
    </div>
  );
}

/* ─── Main Prototype Component ─── */
export function PrototypeChoosePath() {
  const [phase, setPhase] = useState<Phase>('questions');
  const [currentQuestionId, setCurrentQuestionId] = useState('experience');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [generatedSteps, setGeneratedSteps] = useState<GeneratedStep[]>([]);
  const [completed, setCompleted] = useState(false);

  const currentQuestion = QUESTIONS.find((q) => q.id === currentQuestionId);

  const handleAnswer = useCallback(
    (option: PathOption) => {
      const newAnswers = { ...answers, [currentQuestionId]: option.id };
      const newTags = [...tags, ...option.tags];
      setAnswers(newAnswers);
      setTags(newTags);

      if (option.next) {
        setCurrentQuestionId(option.next);
      } else {
        // Generate the path
        const steps = generatePath(newTags);
        setGeneratedSteps(steps);
        setPhase('path-preview');
      }
    },
    [answers, currentQuestionId, tags]
  );

  const handleReset = useCallback(() => {
    setPhase('questions');
    setCurrentQuestionId('experience');
    setAnswers({});
    setTags([]);
    setGeneratedSteps([]);
    setCompleted(false);
  }, []);

  // Find previous question for back navigation
  const questionHistory = Object.keys(answers);
  const canGoBack = questionHistory.length > 0 && phase === 'questions';

  const handleBack = useCallback(() => {
    if (questionHistory.length === 0) return;
    const lastAnsweredId = questionHistory[questionHistory.length - 1];
    const lastAnswer = answers[lastAnsweredId];
    const lastOption = QUESTIONS.find((q) => q.id === lastAnsweredId)?.options.find(
      (o) => o.id === lastAnswer
    );

    // Remove last answer and its tags
    const newAnswers = { ...answers };
    delete newAnswers[lastAnsweredId];
    setAnswers(newAnswers);

    if (lastOption) {
      setTags(tags.filter((t) => !lastOption.tags.includes(t)));
    }
    setCurrentQuestionId(lastAnsweredId);
  }, [answers, questionHistory, tags]);

  return (
    <div
      style={{ height: '100vh', overflow: 'auto' }}
      className="bg-[#0b1110] text-[#e6f2ee]"
    >
      {/* Header */}
      <div className="sticky top-0 z-50 bg-[rgba(8,15,12,0.85)] backdrop-blur-xl border-b border-[rgba(34,197,94,0.08)]">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-green-500/20 flex items-center justify-center text-green-400 text-xs font-bold">
              S
            </div>
            <span className="text-sm font-semibold text-[#e6f2ee]">SAM Setup</span>
          </div>
          {phase === 'questions' && (
            <div className="flex items-center gap-2">
              {canGoBack && (
                <button onClick={handleBack} className={btnGhost}>
                  <ArrowLeft size={12} /> Back
                </button>
              )}
              <span className="text-xs text-[#9fb7ae]/50">
                Question {Object.keys(answers).length + 1} of ~{QUESTIONS.length}
              </span>
            </div>
          )}
          {phase === 'path-preview' && (
            <span className="text-xs text-[#9fb7ae]/50">Your setup plan</span>
          )}
          {phase === 'executing' && !completed && (
            <span className="text-xs text-[#9fb7ae]/50">Setting up...</span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 py-8">
        {phase === 'questions' && currentQuestion && (
          <QuestionCard
            question={currentQuestion}
            onSelect={handleAnswer}
            selectedId={answers[currentQuestionId] ?? null}
          />
        )}
        {phase === 'path-preview' && (
          <PathPreview
            steps={generatedSteps}
            tags={tags}
            onStart={() => setPhase('executing')}
            onReset={handleReset}
          />
        )}
        {phase === 'executing' && !completed && (
          <StepExecution steps={generatedSteps} onComplete={() => setCompleted(true)} />
        )}
        {completed && <CompletionScreen />}
      </div>

      {/* Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-[rgba(8,15,12,0.85)] backdrop-blur-xl border-t border-[rgba(34,197,94,0.08)]">
        <div className="max-w-2xl mx-auto px-4 py-2 flex justify-between items-center">
          <span className="text-[10px] text-[#9fb7ae]/40">PROTOTYPE — Choose Your Path</span>
          <div className="flex gap-2 text-[10px] text-[#9fb7ae]/30">
            {(['questions', 'path-preview', 'executing'] as Phase[]).map((p) => (
              <button
                key={p}
                onClick={() => {
                  if (p === 'questions') handleReset();
                  else setPhase(p);
                }}
                className={`px-2 py-0.5 rounded cursor-pointer border-none ${
                  phase === p ? 'bg-green-500/20 text-green-400' : 'bg-transparent'
                }`}
              >
                {p.replace('-', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
