import { Button } from '@simple-agent-manager/ui';

interface StepHowItWorksProps {
  onComplete: () => void;
}

export function StepHowItWorks({ onComplete }: StepHowItWorksProps) {
  return (
    <div>
      <h3 className="sam-type-section-heading text-fg-primary m-0 mb-1">How SAM works</h3>
      <p className="sam-type-body text-fg-muted m-0 mb-4">
        Every project has a chat. You send a message, SAM handles the rest.
      </p>

      {/* Flow diagram */}
      <div className="flex flex-col gap-2 mb-6">
        <FlowStep
          number="1"
          title="You send a message"
          description="Describe what you want — a feature, bug fix, question, or brainstorm."
        />
        <div className="flex justify-center">
          <span className="text-fg-muted text-lg">{'\u2193'}</span>
        </div>
        <FlowStep
          number="2"
          title="SAM provisions a workspace"
          description="A cloud VM with your repo cloned, dependencies installed, and your AI agent ready."
        />
        <div className="flex justify-center">
          <span className="text-fg-muted text-lg">{'\u2193'}</span>
        </div>
        <FlowStep
          number="3"
          title="Your agent codes"
          description="It works in a real environment — running tests, installing packages, using git."
        />
        <div className="flex justify-center">
          <span className="text-fg-muted text-lg">{'\u2193'}</span>
        </div>
        <FlowStep
          number="4"
          title="You review the results"
          description="The agent pushes a branch and can create a PR. You review and merge."
        />
      </div>

      {/* Two speeds comparison */}
      <div className="border border-border-default rounded-md overflow-hidden mb-6">
        <div className="p-3 bg-inset border-b border-border-default">
          <p className="sam-type-body text-fg-primary font-medium m-0">Choose your speed</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2">
          <div className="p-3 border-b sm:border-b-0 sm:border-r border-border-default">
            <p className="text-sm font-medium text-fg-primary m-0 mb-1">Task mode</p>
            <p className="text-xs text-fg-muted m-0 mb-2">Full devcontainer, 1-3 min startup</p>
            <ul className="m-0 pl-4 text-xs text-fg-muted list-disc grid gap-0.5">
              <li>Builds your devcontainer config</li>
              <li>Full development environment</li>
              <li>Best for real implementation work</li>
            </ul>
          </div>
          <div className="p-3">
            <p className="text-sm font-medium text-fg-primary m-0 mb-1">Conversation mode</p>
            <p className="text-xs text-fg-muted m-0 mb-2">Lightweight, ~20s startup</p>
            <ul className="m-0 pl-4 text-xs text-fg-muted list-disc grid gap-0.5">
              <li>Skips devcontainer build</li>
              <li>Quick brainstorming &amp; questions</li>
              <li>Best for exploration &amp; small fixes</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Devcontainer note */}
      <div className="border border-border-default rounded-md p-3 mb-4 bg-inset">
        <p className="text-xs text-fg-muted m-0">
          <strong className="text-fg-primary">Tip:</strong> If your repo has a <code className="text-xs">.devcontainer</code> config, SAM uses it automatically.
          Otherwise, it uses a sensible default with common dev tools pre-installed.
        </p>
      </div>

      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={onComplete}>
          Got it, let&apos;s go!
        </Button>
      </div>
    </div>
  );
}

function FlowStep({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 p-3 border border-border-default rounded-md bg-surface">
      <div className="shrink-0 w-6 h-6 rounded-full bg-accent text-white text-xs font-bold flex items-center justify-center">
        {number}
      </div>
      <div>
        <p className="text-sm font-medium text-fg-primary m-0">{title}</p>
        <p className="text-xs text-fg-muted m-0 mt-0.5">{description}</p>
      </div>
    </div>
  );
}
