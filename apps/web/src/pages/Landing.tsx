import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithGitHub } from '../lib/auth';
import { useAuth } from '../components/AuthProvider';
import { Button, Card, Typography, Container } from '@simple-agent-manager/ui';

/**
 * Marketing landing page with feature highlights and GitHub OAuth sign-in.
 */
export function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleSignIn = async () => {
    try {
      await signInWithGitHub();
    } catch (error) {
      console.error('Failed to sign in:', error);
    }
  };

  return (
    <div className="min-h-[var(--sam-app-height)] bg-canvas">
      {/* Hero */}
      <section className="flex flex-col items-center justify-center px-4 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
        <Container maxWidth="lg">
          <Typography variant="display" className="mb-4">
            Simple Agent Manager
          </Typography>
          <p className="text-lg sm:text-xl text-muted max-w-2xl mx-auto mb-6">
            Launch AI coding agents on cloud VMs in seconds. Bring your own
            Hetzner or Scaleway account, pick an agent, and let it build.
          </p>
          <div className="flex flex-wrap justify-center gap-3 mb-8">
            {['Claude Code', 'OpenAI Codex', 'Gemini CLI', 'Mistral Vibe'].map(
              (name) => (
                <span
                  key={name}
                  className="px-3 py-1 rounded-full bg-surface border border-border-default text-sm font-medium"
                >
                  {name}
                </span>
              ),
            )}
          </div>
          <Button onClick={handleSignIn} size="lg">
            <GitHubIcon />
            Sign in with GitHub
          </Button>
          <p className="text-xs text-muted mt-3">
            Secure OAuth &bull; No password needed &bull; Free to start
          </p>
        </Container>
      </section>

      {/* Value props */}
      <section className="px-4 pb-12 sm:pb-16">
        <Container maxWidth="lg">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                label: 'Multi-Cloud VMs',
                sub: 'Hetzner & Scaleway',
                color: 'text-info',
              },
              {
                label: '4 AI Agents',
                sub: 'Claude, Codex, Gemini, Mistral',
                color: 'text-success',
              },
              {
                label: 'Pay As You Go',
                sub: 'Your cloud, your costs',
                color: 'text-purple',
              },
            ].map((item) => (
              <div
                key={item.label}
                className="text-center p-4 bg-surface rounded-md border border-border-default"
              >
                <div
                  className={`text-[length:var(--sam-type-section-heading-size)] font-[number:var(--sam-type-section-heading-weight)] ${item.color}`}
                >
                  {item.label}
                </div>
                <Typography variant="caption">{item.sub}</Typography>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* How It Works */}
      <section className="px-4 pb-12 sm:pb-16">
        <Container maxWidth="lg">
          <Typography
            variant="heading"
            className="text-center mb-8"
          >
            How It Works
          </Typography>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
            {[
              {
                step: '1',
                title: 'Connect Your Cloud',
                desc: 'Add your Hetzner or Scaleway API token. Your credentials, your infrastructure.',
              },
              {
                step: '2',
                title: 'Create a Project',
                desc: 'Link a GitHub repo. SAM organizes tasks, chat sessions, and workspaces per project.',
              },
              {
                step: '3',
                title: 'Describe Your Task',
                desc: 'Type what you need in the project chat. SAM provisions a VM and assigns an agent automatically.',
              },
              {
                step: '4',
                title: 'Watch It Build',
                desc: 'Stream agent output in real time. Get notified when the agent needs input or finishes.',
              },
            ].map((item) => (
              <Card key={item.step} className="p-5 text-center">
                <div className="w-8 h-8 rounded-full bg-accent-emphasis text-on-accent text-sm font-bold flex items-center justify-center mx-auto mb-3">
                  {item.step}
                </div>
                <Typography variant="body" className="font-semibold mb-1">
                  {item.title}
                </Typography>
                <Typography variant="caption">{item.desc}</Typography>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* Agent Comparison */}
      <section className="px-4 pb-12 sm:pb-16">
        <Container maxWidth="lg">
          <Typography
            variant="heading"
            className="text-center mb-8"
          >
            Choose Your Agent
          </Typography>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                name: 'Claude Code',
                by: 'Anthropic',
                highlights: [
                  'Extended thinking',
                  'Agentic tool use',
                  'API key or OAuth',
                ],
              },
              {
                name: 'OpenAI Codex',
                by: 'OpenAI',
                highlights: [
                  'Code-optimized model',
                  'Fast iteration',
                  'OpenAI API key',
                ],
              },
              {
                name: 'Gemini CLI',
                by: 'Google',
                highlights: [
                  'Large context window',
                  'Multi-modal',
                  'Google API key',
                ],
              },
              {
                name: 'Mistral Vibe',
                by: 'Mistral AI',
                highlights: [
                  'Devstral 2 model',
                  'Terminal-native',
                  'Mistral API key',
                ],
              },
            ].map((agent) => (
              <Card key={agent.name} className="p-5">
                <Typography variant="body" className="font-semibold mb-1">
                  {agent.name}
                </Typography>
                <Typography variant="caption" className="mb-3 block">
                  {agent.by}
                </Typography>
                <ul className="space-y-1">
                  {agent.highlights.map((h) => (
                    <li key={h} className="text-xs text-muted flex items-start gap-1.5">
                      <span className="text-success mt-0.5 shrink-0">&#10003;</span>
                      {h}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* Features */}
      <section className="px-4 pb-12 sm:pb-16">
        <Container maxWidth="lg">
          <Typography
            variant="heading"
            className="text-center mb-8"
          >
            Platform Features
          </Typography>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                title: 'Chat-Driven Tasks',
                desc: 'Describe what you need in natural language. SAM provisions infrastructure and runs the agent for you.',
              },
              {
                title: 'Real-Time Notifications',
                desc: 'Get alerted when agents need input, complete tasks, or hit blockers. Grouped by project.',
              },
              {
                title: 'Voice Input & TTS',
                desc: 'Speak your tasks instead of typing. Listen to agent responses with text-to-speech playback.',
              },
              {
                title: 'Conversation Forking',
                desc: 'Branch off any completed session with AI-generated context summaries to continue where you left off.',
              },
              {
                title: 'Port Exposure',
                desc: 'Dev servers running in workspaces are automatically detected and accessible via unique subdomains.',
              },
              {
                title: 'Global Command Palette',
                desc: 'Jump to any project, workspace, or action instantly with Cmd+K. Fast keyboard-driven navigation.',
              },
              {
                title: 'Warm Node Pooling',
                desc: 'Recently used VMs stay warm for 30 minutes so your next task starts in seconds, not minutes.',
              },
              {
                title: 'AI Task Titles',
                desc: 'Task titles are generated automatically from your message using on-device AI. No manual naming.',
              },
              {
                title: 'Session Suspend & Resume',
                desc: 'Pause agent sessions and pick them up later without losing context or progress.',
              },
            ].map((f) => (
              <Card key={f.title} className="p-5">
                <Typography variant="body" className="font-semibold mb-1">
                  {f.title}
                </Typography>
                <Typography variant="caption">{f.desc}</Typography>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* BYOC */}
      <section className="px-4 pb-12 sm:pb-16">
        <Container maxWidth="lg">
          <Card className="p-6 sm:p-8 text-center">
            <Typography variant="heading" className="mb-4">
              Bring Your Own Cloud
            </Typography>
            <p className="text-sm text-muted max-w-xl mx-auto mb-6">
              SAM never holds your cloud credentials on its servers. Your
              Hetzner or Scaleway API token is encrypted per-user and used
              only to provision VMs on your account. You pay your cloud
              provider directly — no markup.
            </p>
            <div className="flex flex-wrap justify-center gap-6">
              <div className="text-center">
                <div className="text-2xl font-bold text-info">Hetzner</div>
                <Typography variant="caption">
                  EU &amp; US regions
                </Typography>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-info">Scaleway</div>
                <Typography variant="caption">
                  Paris, Amsterdam, Warsaw
                </Typography>
              </div>
            </div>
          </Card>
        </Container>
      </section>

      {/* Shipped Features / Roadmap */}
      <section className="px-4 pb-12 sm:pb-16">
        <Container maxWidth="lg">
          <Typography
            variant="heading"
            className="text-center mb-8"
          >
            Shipped & Planned
          </Typography>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <Typography variant="body" className="font-semibold mb-3">
                Shipped
              </Typography>
              <ul className="space-y-2">
                {[
                  'Multi-cloud support (Hetzner + Scaleway)',
                  '4 agents: Claude Code, Codex, Gemini CLI, Mistral Vibe',
                  'Chat-driven autonomous task execution',
                  'Real-time notification system',
                  'Voice input & text-to-speech',
                  'Conversation forking with AI summaries',
                  'Global command palette (Cmd+K)',
                  'Workspace port exposure & subdomain routing',
                  'Session suspend & resume',
                  'AI-powered task title generation',
                  'Warm node pooling for fast start',
                  'Admin observability dashboard',
                ].map((item) => (
                  <li
                    key={item}
                    className="text-sm flex items-start gap-2"
                  >
                    <span className="text-success shrink-0">&#10003;</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Typography variant="body" className="font-semibold mb-3">
                Coming Next
              </Typography>
              <ul className="space-y-2">
                {[
                  'Team workspaces & collaboration',
                  'Additional cloud providers',
                  'Custom agent integrations',
                  'Usage analytics & cost tracking',
                  'Workspace templates & presets',
                ].map((item) => (
                  <li
                    key={item}
                    className="text-sm flex items-start gap-2 text-muted"
                  >
                    <span className="shrink-0">&#9675;</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Container>
      </section>

      {/* CTA */}
      <section className="px-4 pb-16 sm:pb-24">
        <Container maxWidth="sm">
          <Card className="p-6 text-center">
            <Typography variant="body" className="font-semibold mb-2">
              Ready to start building?
            </Typography>
            <Typography variant="caption" className="mb-4 block">
              Sign in with GitHub to create your first project.
            </Typography>
            <Button onClick={handleSignIn} size="lg" className="w-full">
              <GitHubIcon />
              Sign in with GitHub
            </Button>
          </Card>
        </Container>
      </section>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}
