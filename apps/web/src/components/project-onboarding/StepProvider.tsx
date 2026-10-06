import type { RepoProvider } from '@simple-agent-manager/shared';
import { Check, Cloud, Github, Gitlab, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { StepHeader, WhyDetails } from './explain';

interface ProviderOption {
  id: RepoProvider;
  icon: LucideIcon;
  title: string;
  tagline: string;
  bullets: string[];
}

const OPTIONS: ProviderOption[] = [
  {
    id: 'github',
    icon: Github,
    title: 'Connect a GitHub repository',
    tagline: 'Your code already lives on GitHub.',
    bullets: [
      'SAM reaches your repo through a GitHub App installation.',
      'Task agents push their branch and open a pull request for review.',
      'Best when your team already collaborates on GitHub.',
    ],
  },
  {
    id: 'gitlab',
    icon: Gitlab,
    title: 'Connect a GitLab project',
    tagline: 'Your code already lives on GitLab.',
    bullets: [
      'SAM reaches your repo through your GitLab OAuth connection.',
      'Task agents clone the project and push their branch back to GitLab.',
      'Best when your team already collaborates on GitLab.',
    ],
  },
  {
    id: 'artifacts',
    icon: Cloud,
    title: 'Let SAM host the repository',
    tagline: 'Start fresh — no GitHub account needed.',
    bullets: [
      'SAM creates and hosts a Git repo for you on Cloudflare Artifacts.',
      'Agents push directly to branches on the SAM-hosted remote (no pull requests).',
      'Best for greenfield projects or trying SAM without connecting GitHub.',
    ],
  },
];

function OptionCard({
  option,
  selected,
  onSelect,
}: Readonly<{
  option: ProviderOption;
  selected: boolean;
  onSelect: () => void;
}>) {
  const Icon = option.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`grid gap-3 rounded-md border p-4 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/10'
          : 'border-border-default bg-surface hover:bg-surface-hover'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Icon size={20} className="text-accent" aria-hidden="true" />
          <span className="text-sm font-semibold text-fg-primary">{option.title}</span>
        </span>
        <span
          className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
            selected
              ? 'border-accent bg-accent text-white'
              : 'border-border-default text-transparent'
          }`}
          aria-hidden="true"
        >
          <Check size={12} />
        </span>
      </div>
      <span className="text-xs font-medium text-fg-secondary">{option.tagline}</span>
      <ul className="grid gap-1.5">
        {option.bullets.map((bullet) => (
          <li key={bullet} className="flex items-start gap-2 text-xs text-fg-muted">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-fg-muted" aria-hidden="true" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

export function StepProvider({
  value,
  onChange,
  artifactsEnabled = true,
  gitlabEnabled = false,
  note,
}: Readonly<{
  value: RepoProvider;
  onChange: (provider: RepoProvider) => void;
  artifactsEnabled?: boolean;
  gitlabEnabled?: boolean;
  note?: ReactNode;
}>) {
  const options = OPTIONS.filter((option) => {
    if (option.id === 'artifacts') return artifactsEnabled;
    if (option.id === 'gitlab') return gitlabEnabled;
    return true;
  });
  return (
    <div className="grid gap-4">
      <StepHeader
        id="provider"
        title="Where should your code live?"
        lead="SAM can work against a repository you already have on GitHub or GitLab, or it can host a brand-new Git repository for you. Each option gives agents a repo to clone, edit, and push to — the difference is who owns the remote and how finished work is reviewed."
      />
      <div
        role="radiogroup"
        aria-label="Where your code lives"
        className={`grid gap-3 ${options.length > 2 ? 'lg:grid-cols-3' : options.length > 1 ? 'sm:grid-cols-2' : ''}`}
      >
        {options.map((option) => (
          <OptionCard
            key={option.id}
            option={option}
            selected={value === option.id}
            onSelect={() => onChange(option.id)}
          />
        ))}
      </div>
      {note}
      <WhyDetails question="How do I choose, and can I change it later?">
        <p>
          <strong className="text-fg-secondary">GitHub</strong> is the right pick when your code
          already lives there and you want the usual pull-request review flow — SAM mints a
          short-lived, repository-scoped token from your GitHub App installation each time an agent
          runs.
        </p>
        <p>
          <strong className="text-fg-secondary">GitLab</strong> is the right pick when your code
          already lives there and you want agents to clone and push branches back to GitLab using
          your current GitLab authorization.
        </p>
        <p>
          <strong className="text-fg-secondary">SAM-hosted (Cloudflare Artifacts)</strong> is the
          fastest way to start from nothing: SAM provisions a private Git repo, seeds it with a
          README, and agents push straight to it. There’s no GitHub App to install and no pull
          requests — you review changes as branches on the SAM-hosted remote.
        </p>
        <p>
          The repository backing a project is fixed once it’s created, so pick the one that fits
          this project. You can always create another project with the other option.
        </p>
      </WhyDetails>
    </div>
  );
}
