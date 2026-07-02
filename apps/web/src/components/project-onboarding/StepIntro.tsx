import { Bot, Box, Github, Lightbulb, Rocket, Trash2, UploadCloud } from 'lucide-react';

import { Callout, InfoCard, StepHeader, WhyDetails } from './explain';

export function StepWelcome() {
  return (
    <div className="grid gap-4">
      <StepHeader
        id="welcome"
        title="Let's create your project"
        lead="A project links one repository to the agents, conversations, tasks, and automations that work on it. We'll walk through each piece, explain why it matters, and you can skip anything you'd rather set up later."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoCard icon={Github} title="Connect code" body="Point SAM at a repo and branch." />
        <InfoCard icon={Bot} title="Add agents" body="Decide who does conversations and tasks." />
        <InfoCard icon={Rocket} title="Kick off" body="Start the first task or chat." />
      </div>
      <WhyDetails question="Why organize work into projects?">
        <p>
          Everything an agent needs lives in one place: the repo it can read and write, the profiles
          that define how it behaves, the chat history, and the tasks it has run. That scoping is also
          a security boundary — an agent in this project can’t reach another project’s code or
          credentials.
        </p>
      </WhyDetails>
    </div>
  );
}

export function StepHowSamWorks() {
  return (
    <div className="grid gap-4">
      <StepHeader
        id="how-sam-works"
        title="How SAM works"
        lead="Before you configure anything, here's the one idea that makes everything else click: every conversation and every task runs in its own fresh, isolated, throwaway dev container. Agents get a full Linux box they can do anything with — but it disappears when the work ends."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoCard
          icon={Box}
          title="Fresh & isolated"
          body="Each run spins up its own container with your repo cloned in. Agents can install Docker, packages, anything — sandboxed away from your machine and other projects."
        />
        <InfoCard
          icon={Trash2}
          title="Ephemeral by default"
          body="When the conversation or task ends, the container is torn down. Nothing inside it survives unless you deliberately persist it."
        />
        <InfoCard
          icon={UploadCloud}
          title="You decide what is kept"
          body="Persistence is opt-in: tell the agent to push to a branch, upload to the SAM library, or capture results as a SAM idea."
        />
      </div>
      <Callout variant="warn">
        <strong className="font-semibold text-fg-primary">Workspaces are ephemeral.</strong> A task agent
        auto-pushes its branch and opens a PR when it finishes, so its work survives. A conversation agent
        does not — if it edits files or produces output and you don’t tell it to push or persist that work,
        it’s gone when the workspace stops.
      </Callout>
      <WhyDetails question="Where can work go so it survives?">
        <p>There are a few durable destinations:</p>
        <ul className="grid gap-1.5 pl-1">
          <li className="flex items-start gap-2">
            <Github size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
            <span>
              <strong className="text-fg-secondary">Push to a branch.</strong> A finished task agent commits
              and pushes its own branch automatically and opens a pull request for review. In a conversation,
              you ask the agent to push when you’re ready.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <UploadCloud size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
            <span>
              <strong className="text-fg-secondary">Upload to the SAM library.</strong> Files, artifacts, and
              notes you want to keep outside of git.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Lightbulb size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
            <span>
              <strong className="text-fg-secondary">Capture as a SAM idea.</strong> Turn findings or follow-up
              work into an idea you can execute later.
            </span>
          </li>
        </ul>
      </WhyDetails>
    </div>
  );
}
