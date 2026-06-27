import { Alert, Button } from '@simple-agent-manager/ui';

import { ModeButton } from './shared';

interface StepKickoffProps {
  kickoffMode: 'task' | 'conversation';
  kickoffMessage: string;
  kickoffError: string | null;
  kickoffSubmitting: boolean;
  onModeChange: (mode: 'task' | 'conversation') => void;
  onMessageChange: (message: string) => void;
  onKickoff: () => void;
  onSkip: () => void;
}

export function StepKickoff({
  kickoffMode,
  kickoffMessage,
  kickoffError,
  kickoffSubmitting,
  onModeChange,
  onMessageChange,
  onKickoff,
  onSkip,
}: StepKickoffProps) {
  return (
    <div className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold text-fg-primary">Kick off</h2>
        <p className="text-sm text-fg-muted">
          Start an initial task or conversation, or skip and do it later from the project page.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <ModeButton
          selected={kickoffMode === 'task'}
          title="Task"
          description="Agent works autonomously on a branch"
          onClick={() => onModeChange('task')}
        />
        <ModeButton
          selected={kickoffMode === 'conversation'}
          title="Conversation"
          description="Interactive chat with an agent"
          onClick={() => onModeChange('conversation')}
        />
      </div>

      <label htmlFor="project-onboarding-kickoff-message" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Message</span>
        <textarea
          id="project-onboarding-kickoff-message"
          value={kickoffMessage}
          onChange={(event) => onMessageChange(event.currentTarget.value)}
          rows={4}
          disabled={kickoffSubmitting}
          className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
        />
      </label>

      {kickoffError && <Alert variant="error">{kickoffError}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onKickoff} disabled={kickoffSubmitting}>
          {kickoffSubmitting ? 'Starting...' : 'Start'}
        </Button>
        <Button type="button" variant="secondary" onClick={onSkip} disabled={kickoffSubmitting}>
          Skip and open project
        </Button>
      </div>
    </div>
  );
}
