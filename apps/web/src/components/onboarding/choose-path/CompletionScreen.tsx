import { Button, Card } from '@simple-agent-manager/ui';
import { Check, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';

export function CompletionScreen() {
  const navigate = useNavigate();

  return (
    <div className="max-w-md mx-auto text-center">
      <div className="mt-8 mb-6">
        <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
          <Check size={36} className="text-success" />
        </div>
        <h2 className="sam-type-page-title text-fg-primary mb-2">You're all set!</h2>
        <p className="text-fg-muted max-w-sm mx-auto">
          Your account is configured and ready to go. Start a chat in your project to begin.
        </p>
      </div>

      <Card className="p-5 text-left mb-6">
        <p className="text-xs text-fg-muted/50 uppercase tracking-wide font-medium mb-3">
          What's next
        </p>
        <div className="flex flex-col gap-3">
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
              <div className="w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-xs text-accent font-bold shrink-0">
                {i + 1}
              </div>
              <div>
                <p className="text-sm font-medium text-fg-primary">{item.title}</p>
                <p className="text-xs text-fg-muted">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Button
        variant="primary"
        size="lg"
        onClick={() => navigate('/projects')}
        className="w-full max-w-xs"
      >
        <Sparkles size={14} /> Go to my projects
      </Button>
      <p className="text-[10px] text-fg-muted/30 mt-3">
        You can change any setting in Settings anytime
      </p>
    </div>
  );
}
