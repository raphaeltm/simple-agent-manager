import type { Repository } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { Button, Input } from '@simple-agent-manager/ui';
import { ArrowRight, Loader2 } from 'lucide-react';

import type { StepId } from './path-generator';
import { ProjectSelector } from './ProjectSelector';
import type { StepFormState } from './step-actions';

/* ─── Props ─── */

interface StepFormProps {
  stepId: StepId;
  tags: string[];
  form: StepFormState;
  setForm: React.Dispatch<React.SetStateAction<StepFormState>>;
  loading: boolean;
  repos: Repository[];
  reposLoading: boolean;
  onLoadRepos: () => void;
  onAction: () => void;
  onGitHubInstall: () => void;
  onCreateProject: () => void;
  onSkip?: () => void;
  actionLabel: string;
}

/* ─── Component ─── */

export function StepForm({
  stepId,
  tags,
  form,
  setForm,
  loading,
  repos,
  reposLoading,
  onLoadRepos,
  onAction,
  onGitHubInstall,
  onCreateProject,
  onSkip,
  actionLabel,
}: StepFormProps) {
  switch (stepId) {
    case 'ai-apikey': {
      const isAnthropic = tags.includes('anthropic-key') || tags.includes('has-claude');
      const agents = AGENT_CATALOG.filter((a) =>
        isAnthropic ? a.provider === 'anthropic' : a.provider === 'openai'
      );

      return (
        <>
          {agents.length > 1 && (
            <div className="mb-3">
              <label className="block text-xs font-medium text-fg-muted mb-1">Agent</label>
              <div className="flex gap-2 flex-wrap">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={form.selectedAgent === agent.id}
                    onClick={() => setForm((prev) => ({ ...prev, selectedAgent: agent.id }))}
                    className={`px-3 py-2.5 rounded text-xs border cursor-pointer transition-colors min-h-[44px] ${
                      form.selectedAgent === agent.id
                        ? 'border-accent bg-accent/10 text-fg-primary'
                        : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
                    }`}
                  >
                    {agent.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mb-3">
            <label htmlFor="onboarding-api-key" className="block text-xs font-medium text-fg-muted mb-1">
              {isAnthropic ? 'Anthropic' : 'OpenAI'} API key
            </label>
            <Input
              id="onboarding-api-key"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder="sk-..."
            />
            {agents[0] && (
              <a
                href={agents[0].credentialHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline mt-1 inline-block"
              >
                Where do I get this?
              </a>
            )}
          </div>
          <ActionButton
            onClick={onAction}
            loading={loading}
            disabled={!form.apiKey.trim() || !form.selectedAgent}
            label={actionLabel}
          />
        </>
      );
    }

    case 'ai-oauth':
      return (
        <>
          <p className="text-xs text-fg-muted mb-3">
            Connect your Claude subscription in Settings after completing setup.
            Your existing plan covers all costs.
          </p>
          <ActionButton onClick={onAction} loading={loading} label="Continue" />
        </>
      );

    case 'ai-sam':
    case 'cloud-sam':
      return (
        <div className="flex items-center gap-2">
          <ActionButton onClick={onAction} loading={loading} label="Continue" />
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer min-h-[44px]"
            >
              Skip
            </button>
          )}
        </div>
      );

    case 'cloud-hetzner':
      return (
        <>
          <div className="mb-3">
            <label htmlFor="onboarding-hetzner-token" className="block text-xs font-medium text-fg-muted mb-1">
              Hetzner API token
            </label>
            <Input
              id="onboarding-hetzner-token"
              type="password"
              autoComplete="off"
              value={form.hetznerToken}
              onChange={(e) => setForm((prev) => ({ ...prev, hetznerToken: e.target.value }))}
              placeholder="Paste your token"
            />
            <a
              href="https://console.hetzner.cloud/projects"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent hover:underline mt-1 inline-block"
            >
              Get a token from Hetzner Console
            </a>
          </div>
          <ActionButton
            onClick={onAction}
            loading={loading}
            disabled={!form.hetznerToken.trim()}
            label={actionLabel}
          />
        </>
      );

    case 'github':
      return (
        <>
          <ActionButton onClick={onGitHubInstall} loading={loading} label={actionLabel} />
          {loading && (
            <p className="text-xs text-fg-muted mt-2">
              Complete the installation in the new tab. This will update automatically.
            </p>
          )}
        </>
      );

    case 'project':
      return (
        <ProjectSelector
          repos={repos}
          reposLoading={reposLoading}
          onLoadRepos={onLoadRepos}
          form={form}
          setForm={setForm}
          loading={loading}
          onCreateProject={onCreateProject}
        />
      );

    default:
      return <ActionButton onClick={onAction} loading={loading} label={actionLabel} />;
  }
}

/* ─── ActionButton ─── */

export function ActionButton({
  onClick,
  loading,
  disabled,
  label,
}: {
  onClick: () => void;
  loading: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Button
      variant="primary"
      size="md"
      onClick={onClick}
      disabled={loading || disabled}
    >
      {loading ? (
        <>
          <Loader2 size={14} className="animate-spin" /> Setting up...
        </>
      ) : (
        <>
          {label} <ArrowRight size={14} />
        </>
      )}
    </Button>
  );
}
