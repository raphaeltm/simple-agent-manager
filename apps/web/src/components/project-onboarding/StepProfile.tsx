import type { AgentInfo } from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Callout, StepHeader, WhyDetails } from './explain';
import { type ProfileDraft, ProfileSetupPanel } from './shared';

interface ProfileCopy {
  title: string;
  lead: string;
  callout: ReactNode;
  panelTitle: string;
  whyQuestion: string;
  why: ReactNode;
}

const COPY: Record<'conversation' | 'task', ProfileCopy> = {
  conversation: {
    title: 'Set up a conversation agent',
    lead: "A conversation profile powers interactive chat — you talk to the agent, it reads and edits code live, and you stay in the loop. It's long-running and open-ended: it stays up as long as you're working with it. This is the agent you'll reach for most often.",
    callout: (
      <>
        Conversation profiles default to a <strong className="font-semibold text-fg-primary">lightweight</strong>{' '}
        workspace — it skips the devcontainer build for a faster start, since interactive chat usually doesn’t
        need the full environment spun up.
      </>
    ),
    panelTitle: 'Conversation profile',
    whyQuestion: "What's a profile, and how does a conversation agent end?",
    why: (
      <>
        <p>
          A profile bundles an agent (Claude Code, Codex, …), an optional model override, and a permission
          policy into a reusable preset. Conversation profiles are tuned for fast, interactive turns; task
          profiles are tuned to run a single job autonomously.
        </p>
        <p>
          A conversation has no built-in “done” — it’s open-ended. It stays alive while you chat and is
          cleaned up after the workspace sits idle past its timeout. Remember the workspace is ephemeral: ask
          the agent to push or persist anything you want to keep before you walk away.
        </p>
      </>
    ),
  },
  task: {
    title: 'Set up a task agent',
    lead: 'A task profile runs a single, one-off job autonomously and is expected to finish on its own. Use it for work you can hand off and review later instead of watching live.',
    callout: (
      <>
        Task profiles default to a <strong className="font-semibold text-fg-primary">full</strong> workspace —
        the complete devcontainer build, so an autonomous job runs against an environment that matches your
        repo exactly with no missing tooling.
      </>
    ),
    panelTitle: 'Task profile',
    whyQuestion: "How does a task know it's done, and what if it stalls?",
    why: (
      <>
        <p>
          A task agent works on its own branch and is expected to wrap up by calling a completion tool when
          the job is finished. Because the work is isolated on a branch, it can’t disrupt your default branch
          or another agent’s work.
        </p>
        <p>
          If the agent goes quiet without finishing, SAM’s scheduler checks in and asks whether it’s still on
          track. If it doesn’t respond, SAM marks the task failed and cleans up the workspace — so a stuck
          task never lingers and burns resources.
        </p>
      </>
    ),
  },
};

export function StepProfile({
  kind,
  draft,
  configuredAgents,
  agentsLoading,
  agentsError,
  onChange,
  onRefreshAgents,
}: {
  kind: 'conversation' | 'task';
  draft: ProfileDraft;
  configuredAgents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  onChange: (next: ProfileDraft) => void;
  onRefreshAgents: () => void;
}) {
  const copy = COPY[kind];
  return (
    <div className="grid gap-4">
      <StepHeader id={kind} title={copy.title} lead={copy.lead} />
      <Callout variant="info">{copy.callout}</Callout>

      {agentsError && (
        <Alert variant="error">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{agentsError}</span>
            <Button type="button" variant="secondary" onClick={onRefreshAgents}>
              Retry
            </Button>
          </div>
        </Alert>
      )}

      {!agentsLoading && !agentsError && configuredAgents.length === 0 && (
        <Alert variant="warning">
          No agents are configured yet. Add an agent API key or OAuth token in{' '}
          <Link to="/settings" className="underline">
            Settings
          </Link>{' '}
          to create profiles, or skip this step and add them later.
        </Alert>
      )}

      <ProfileSetupPanel
        title={copy.panelTitle}
        draft={draft}
        configuredAgents={configuredAgents}
        disabled={agentsLoading}
        onChange={onChange}
      />

      <WhyDetails question={copy.whyQuestion}>{copy.why}</WhyDetails>
    </div>
  );
}
