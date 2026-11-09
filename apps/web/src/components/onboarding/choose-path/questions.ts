/**
 * The onboarding decision tree: at most two questions, and only the ones this installation and
 * this user leave open. A question with a single possible answer, or one the user's existing
 * setup already answers, is never shown.
 */
import type { LucideIcon } from 'lucide-react';
import { Cloud, GitBranch, PackageOpen, Server, Zap } from 'lucide-react';

/** Where agents run. */
export type RuntimeChoice = 'instant' | 'platform' | 'byoc';
/** Where the code lives. */
export type RepoChoice = 'hosted' | 'github';

export interface Answers {
  runtime?: RuntimeChoice;
  repo?: RepoChoice;
}

/** What the installation offers and what the user already has. */
export interface SetupContext {
  /** Instant (Cloudflare Containers) can run agents with no cloud account. */
  instantEnabled: boolean;
  /** The installation has its own cloud account SAM can place agents on. */
  platformCompute: boolean;
  /** SAM can host repositories on Cloudflare Artifacts. */
  artifactsEnabled: boolean;
  hasCloud: boolean;
  hasGitHub: boolean;
}

export interface Choice<T extends string> {
  id: T;
  label: string;
  description: string;
  icon: LucideIcon;
}

export type Question =
  | { id: 'runtime'; prompt: string; hint: string; choices: Choice<RuntimeChoice>[] }
  | { id: 'repo'; prompt: string; hint: string; choices: Choice<RepoChoice>[] };

function runtimeChoices(context: SetupContext): Choice<RuntimeChoice>[] {
  const choices: Choice<RuntimeChoice>[] = [];
  if (context.instantEnabled)
    choices.push({
      id: 'instant',
      label: 'Right here, on Cloudflare',
      description: 'Starts in seconds with nothing to sign up for. Great for chatting and changes.',
      icon: Zap,
    });
  if (context.platformCompute)
    choices.push({
      id: 'platform',
      label: "On this installation's machines",
      description: 'Full machines your admin already set up. Nothing to connect.',
      icon: Server,
    });
  choices.push({
    id: 'byoc',
    label: 'On my own cloud account',
    description: 'Full machines that build and test anything. Hetzner, DigitalOcean, GCP and more.',
    icon: Cloud,
  });
  return choices;
}

function repoChoices(context: SetupContext): Choice<RepoChoice>[] {
  const choices: Choice<RepoChoice>[] = [];
  if (context.artifactsEnabled)
    choices.push({
      id: 'hosted',
      label: 'Let SAM keep it',
      description: 'A fresh Git repository in your Cloudflare account. No GitHub needed.',
      icon: PackageOpen,
    });
  choices.push({
    id: 'github',
    label: context.hasGitHub ? 'In my GitHub repositories' : 'On GitHub',
    description: context.hasGitHub
      ? 'Pick one of the repositories SAM can already reach.'
      : 'Connect GitHub and pick a repository. Agents open pull requests for you.',
    icon: GitBranch,
  });
  return choices;
}

/** The answers the user's setup or installation already decides. */
export function presetAnswers(context: SetupContext): Answers {
  const answers: Answers = {};
  const runtimes = runtimeChoices(context);
  // Someone who connected their own cloud wants full machines.
  if (context.hasCloud) answers.runtime = 'byoc';
  else if (runtimes.length === 1) answers.runtime = runtimes[0]?.id;
  const repos = repoChoices(context);
  if (repos.length === 1) answers.repo = repos[0]?.id;
  return answers;
}

/** The questions still open, in order. */
export function openQuestions(context: SetupContext): Question[] {
  const preset = presetAnswers(context);
  const questions: Question[] = [];
  if (!preset.runtime)
    questions.push({
      id: 'runtime',
      prompt: 'Where should your agents work?',
      hint: 'Each agent gets its own workspace. You can mix both later.',
      choices: runtimeChoices(context),
    });
  if (!preset.repo)
    questions.push({
      id: 'repo',
      prompt: 'Where should your code live?',
      hint: 'Agents clone it, commit and push like any Git remote.',
      choices: repoChoices(context),
    });
  return questions;
}
