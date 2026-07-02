import { Alert, Button, Input } from '@simple-agent-manager/ui';

import { StepHeader, WhyDetails } from './explain';
import type { SetupStatus } from './shared';

interface TriggerForm {
  name: string;
  description: string;
  cronExpression: string;
  cronTimezone: string;
  promptTemplate: string;
}

export function StepAutomation({
  triggerForm,
  status,
  error,
  saving,
  onChange,
  onSave,
  onSkip,
}: {
  triggerForm: TriggerForm;
  status: SetupStatus;
  error: string | null;
  saving: boolean;
  onChange: (next: TriggerForm) => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const disabled = status !== 'pending';
  return (
    <div className="grid gap-4">
      <StepHeader
        id="automation"
        title="Schedule automation (optional)"
        lead="A cron trigger runs a task agent on a schedule with a prompt you define — a nightly dependency check, a morning triage, a weekly cleanup. Skip it now and add triggers later from the project page."
      />
      <section className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label htmlFor="project-onboarding-trigger-name" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Name</span>
            <Input
              id="project-onboarding-trigger-name"
              value={triggerForm.name}
              onChange={(event) => onChange({ ...triggerForm, name: event.currentTarget.value })}
              disabled={disabled}
            />
          </label>
          <label htmlFor="project-onboarding-cron" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Schedule</span>
            <Input
              id="project-onboarding-cron"
              value={triggerForm.cronExpression}
              onChange={(event) => onChange({ ...triggerForm, cronExpression: event.currentTarget.value })}
              placeholder="0 9 * * *"
              disabled={disabled}
            />
          </label>
        </div>
        <label htmlFor="project-onboarding-trigger-prompt" className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Prompt</span>
          <textarea
            id="project-onboarding-trigger-prompt"
            value={triggerForm.promptTemplate}
            onChange={(event) => onChange({ ...triggerForm, promptTemplate: event.currentTarget.value })}
            rows={4}
            placeholder="Review open dependency updates and open a PR for any safe bumps."
            disabled={disabled}
            className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
          />
        </label>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onSave} disabled={disabled}>
            {status === 'done' ? 'Trigger created' : saving ? 'Creating...' : 'Create trigger'}
          </Button>
          <Button type="button" variant="secondary" onClick={onSkip} disabled={disabled}>
            Skip
          </Button>
        </div>
      </section>
      <WhyDetails question="How does the schedule field work?">
        <p>
          The schedule uses standard cron syntax. <code>0 9 * * *</code> runs every day at 09:00;{' '}
          <code>0 9 * * 1</code> runs every Monday at 09:00. Each run dispatches a task agent with the prompt
          above through the same pipeline a manual task uses.
        </p>
      </WhyDetails>
    </div>
  );
}
