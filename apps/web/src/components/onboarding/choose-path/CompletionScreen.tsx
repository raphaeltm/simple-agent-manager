import { Button } from '@simple-agent-manager/ui';
import { MessageSquare } from 'lucide-react';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';

import { SamHero } from '../../SamHero';

interface CompletionScreenProps {
  /** The project created during onboarding; its chat is where the user goes next. */
  projectId: string | null;
  onDismiss: () => void;
  /** Receives the heading so the wizard can move focus to it. */
  headingRef?: (el: HTMLHeadingElement | null) => void;
}

/** The hand-off: SAM is ready, and the first chat is one tap away. */
export function CompletionScreen({ projectId, onDismiss, headingRef }: CompletionScreenProps) {
  const navigate = useNavigate();

  const startChatting = useCallback(() => {
    onDismiss();
    navigate(projectId ? `/projects/${projectId}/chat` : '/projects');
  }, [onDismiss, navigate, projectId]);

  return (
    <div className="text-center">
      <SamHero celebrate />
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-[1.6rem] font-bold leading-tight text-fg-primary outline-none sm:text-[1.9rem]"
      >
        We&apos;re ready.
      </h2>
      <p className="mx-auto mb-7 mt-2 max-w-sm text-[0.95rem] text-fg-muted">
        Tell your agent what to build, fix or explain. I&apos;ll give it a workspace and keep you
        posted while it works.
      </p>
      <Button variant="accent" size="lg" className="w-full sm:w-auto" onClick={startChatting}>
        <MessageSquare className="h-5 w-5" aria-hidden="true" />
        {projectId ? 'Start your first chat' : 'Go to my projects'}
      </Button>
      <div>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 min-h-11 cursor-pointer border-0 bg-transparent px-2 text-sm text-fg-muted hover:text-fg-primary"
        >
          Stay on the dashboard
        </button>
      </div>
    </div>
  );
}
