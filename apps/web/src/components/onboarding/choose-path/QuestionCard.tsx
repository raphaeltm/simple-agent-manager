import { ChoiceTile, SamSays } from './OnboardingParts';
import type { Question } from './questions';

interface QuestionCardProps {
  question: Question;
  selectedId: string | null;
  onSelect: (choiceId: string) => void;
  headingRef?: (el: HTMLHeadingElement | null) => void;
}

/** One of SAM's questions, answered by tapping a choice. */
export function QuestionCard({ question, selectedId, onSelect, headingRef }: QuestionCardProps) {
  return (
    <div>
      <SamSays title={question.prompt} headingRef={headingRef}>
        {question.hint}
      </SamSays>
      <div role="group" aria-label={question.prompt} className="flex flex-col gap-2.5">
        {question.choices.map((choice) => (
          <ChoiceTile
            key={choice.id}
            icon={choice.icon}
            label={choice.label}
            description={choice.description}
            selected={selectedId === choice.id}
            onSelect={() => onSelect(choice.id)}
          />
        ))}
      </div>
    </div>
  );
}
