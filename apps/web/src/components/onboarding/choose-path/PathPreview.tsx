import { Button, Card } from '@simple-agent-manager/ui';
import { Check, Clock, Play, RotateCcw, Sparkles } from 'lucide-react';

import type { GeneratedStep } from './path-generator';
import { getTimeEstimate } from './path-generator';

interface PathPreviewProps {
  steps: GeneratedStep[];
  tags: string[];
  onStart: () => void;
  onReset: () => void;
}

export function PathPreview({ steps, tags, onStart, onReset }: PathPreviewProps) {
  const timeEstimate = getTimeEstimate(steps);
  const requiredSteps = steps.filter((s) => !s.isOptional);

  return (
    <div className="max-w-md mx-auto">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
          <Sparkles size={28} className="text-accent" />
        </div>
        <h2 className="sam-type-page-title text-fg-primary mb-2">Your personalized setup</h2>
        <p className="sam-type-body text-fg-muted mb-1">
          Based on your answers, here's what you need to do:
        </p>
        <div className="flex items-center justify-center gap-3 text-xs text-fg-muted/60 mt-2">
          <span className="flex items-center gap-1">
            <Clock size={12} /> {timeEstimate}
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
      <div className="flex flex-col gap-3 mb-8">
        {steps.map((step, i) => (
          <Card
            key={step.id}
            className={`p-4 ${step.isOptional ? 'opacity-60' : ''}`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  step.isOptional
                    ? 'bg-success/10 text-success'
                    : 'bg-accent/20 text-accent'
                }`}
              >
                {step.isOptional ? <Check size={12} /> : i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-fg-primary text-sm">{step.title}</span>
                  <span className="text-[10px] text-fg-muted/40">{step.timeEstimate}</span>
                  {step.isOptional && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success">
                      Done
                    </span>
                  )}
                </div>
                <p className="text-xs text-fg-muted">{step.description}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-col items-center gap-3">
        <Button variant="primary" size="lg" onClick={onStart} className="w-full max-w-xs">
          <Play size={14} /> Start setup ({timeEstimate})
        </Button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-2 text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer"
        >
          <RotateCcw size={14} /> Change my answers
        </button>
      </div>

      {/* Tags summary */}
      <div className="mt-8 text-center">
        <p className="text-[10px] text-fg-muted/30 mb-1">Your profile:</p>
        <div className="flex flex-wrap gap-1 justify-center">
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent/5 text-fg-muted/40"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
