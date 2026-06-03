import { Check, ChevronRight } from 'lucide-react';

import type { PathOption, PathQuestion } from './questions';

interface QuestionCardProps {
  question: PathQuestion;
  selectedId: string | null;
  onSelect: (option: PathOption) => void;
}

export function QuestionCard({ question, selectedId, onSelect }: QuestionCardProps) {
  return (
    <div className="max-w-md mx-auto">
      <h2 className="sam-type-section-heading text-fg-primary mb-1">{question.question}</h2>
      <p className="sam-type-body text-fg-muted mb-6">{question.description}</p>

      <div className="flex flex-col gap-3" role="group" aria-label={question.question}>
        {question.options.map((option) => {
          const isSelected = selectedId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(option)}
              className={`w-full text-left p-4 rounded-lg border transition-all cursor-pointer group bg-surface ${
                isSelected
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-border-default hover:border-fg-muted'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-lg shrink-0">
                  {option.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-fg-primary text-sm">{option.label}</span>
                    {isSelected ? (
                      <Check size={16} className="text-accent" />
                    ) : (
                      <ChevronRight
                        size={14}
                        className="text-fg-muted/20 group-hover:text-fg-muted/50 transition-colors"
                      />
                    )}
                  </div>
                  <p className="text-sm text-fg-muted mt-0.5">{option.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
