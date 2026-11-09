import type { AgentType, Repository } from '@simple-agent-manager/shared';
import { AGENT_CATALOG, getAgentDefinition } from '@simple-agent-manager/shared';
import { Input } from '@simple-agent-manager/ui';

import { ActionButton } from './ActionButton';
import type { StepId } from './path-generator';
import { ProjectSelector } from './ProjectSelector';
import { type AuthMethod, authMethodsForAgent, type StepFormState } from './step-actions';
import { SubscriptionConnect } from './SubscriptionConnect';

/* ─── Props ─── */

interface StepFormProps {
  stepId: StepId;
  form: StepFormState;
  setForm: React.Dispatch<React.SetStateAction<StepFormState>>;
  loading: boolean;
  repos: Repository[];
  reposLoading: boolean;
  onLoadRepos: () => void;
  onAction: () => void;
  onGitHubInstall: () => void;
  onCreateProject: () => void;
  /** The guided subscription sign-in saved a credential: the agent step is done. */
  onAgentConnected: () => void;
  /** The project step creates a SAM-hosted repository instead of picking a GitHub one. */
  hostedRepo?: boolean;
  onSkip?: () => void;
  actionLabel: string;
}

/* ─── Auth-method copy ─── */

const AUTH_METHOD_LABEL: Record<AuthMethod, string> = {
  'api-key': 'API key',
  'oauth-token': 'Subscription',
  sam: 'SAM-managed AI',
};

function authMethodLabel(agentId: string, method: AuthMethod): string {
  if (method === 'oauth-token' && agentId === 'openai-codex') {
    return 'ChatGPT subscription';
  }
  return AUTH_METHOD_LABEL[method];
}

/* ─── Component ─── */

export function StepForm({
  stepId,
  form,
  setForm,
  loading,
  repos,
  reposLoading,
  onLoadRepos,
  onAction,
  onGitHubInstall,
  onCreateProject,
  onAgentConnected,
  hostedRepo = false,
  onSkip,
  actionLabel,
}: StepFormProps) {
  switch (stepId) {
    case 'ai-setup': {
      // Selecting an agent resets the auth method to that agent's first
      // supported option and clears any secret the user typed for a prior agent.
      const selectAgent = (agentId: AgentType) => {
        const methods = authMethodsForAgent(agentId);
        setForm((prev) => ({
          ...prev,
          selectedAgent: agentId,
          selectedAuthMethod: methods[0] ?? null,
          apiKey: '',
          oauthToken: '',
        }));
      };

      const selectMethod = (method: AuthMethod) => {
        setForm((prev) => ({
          ...prev,
          selectedAuthMethod: method,
          apiKey: '',
          oauthToken: '',
        }));
      };

      const selectedAgentId = form.selectedAgent;
      const agentDef = selectedAgentId
        ? getAgentDefinition(selectedAgentId as AgentType)
        : undefined;
      const methods = selectedAgentId ? authMethodsForAgent(selectedAgentId) : [];
      const method = form.selectedAuthMethod;

      const actionDisabled =
        !form.selectedAgent ||
        !method ||
        (method === 'api-key' && !form.apiKey.trim()) ||
        (method === 'oauth-token' && !form.oauthToken.trim());

      return (
        <>
          {/* Agent selection — all catalog agents */}
          <div className="mb-4">
            <span
              id="onboarding-agent-group-label"
              className="block text-xs font-medium text-fg-muted mb-1.5"
            >
              Coding agent
            </span>
            <div
              role="group"
              aria-labelledby="onboarding-agent-group-label"
              className="grid grid-cols-2 gap-2"
            >
              {AGENT_CATALOG.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  aria-pressed={form.selectedAgent === agent.id}
                  onClick={() => selectAgent(agent.id)}
                  className={`px-3 py-2.5 rounded text-left border cursor-pointer transition-colors min-h-[44px] ${
                    form.selectedAgent === agent.id
                      ? 'border-accent bg-accent/10 text-fg-primary'
                      : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
                  }`}
                >
                  <span className="block text-sm font-medium">{agent.name}</span>
                  <span className="block text-xs text-fg-muted/70 mt-0.5">{agent.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Auth-method selection — driven by the selected agent's capabilities */}
          {selectedAgentId && methods.length > 0 && (
            <div className="mb-3">
              <span
                id="onboarding-auth-group-label"
                className="block text-xs font-medium text-fg-muted mb-1.5"
              >
                How do you want to connect?
              </span>
              <div
                role="group"
                aria-labelledby="onboarding-auth-group-label"
                className="flex gap-2 flex-wrap"
              >
                {methods.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={method === m}
                    onClick={() => selectMethod(m)}
                    className={`px-3 py-2.5 rounded text-xs border cursor-pointer transition-colors min-h-[44px] ${
                      method === m
                        ? 'border-accent bg-accent/10 text-fg-primary'
                        : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
                    }`}
                  >
                    {authMethodLabel(selectedAgentId, m)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* API key input */}
          {method === 'api-key' && agentDef && (
            <div className="mb-3">
              <label
                htmlFor="onboarding-api-key"
                className="block text-xs font-medium text-fg-muted mb-1"
              >
                {agentDef.name} API key
              </label>
              <Input
                id="onboarding-api-key"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder="Paste your API key"
              />
              <a
                href={agentDef.credentialHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline mt-1 inline-block"
              >
                Where do I get this?
              </a>
            </div>
          )}

          {/* Subscription: guided sign-in where SAM can run it, paste as the fallback */}
          {method === 'oauth-token' && agentDef?.oauthSupport && selectedAgentId && (
            <SubscriptionConnect
              agentId={selectedAgentId}
              oauthSupport={agentDef.oauthSupport}
              token={form.oauthToken}
              onTokenChange={(value) => setForm((prev) => ({ ...prev, oauthToken: value }))}
              onConnected={onAgentConnected}
            />
          )}

          {/* SAM-managed AI — optional inline budget */}
          {method === 'sam' && (
            <div className="mb-3">
              <p className="text-xs text-fg-muted mb-2">
                SAM routes this agent through its managed AI proxy and bills usage per task. Set
                optional limits below — leave blank for platform defaults.
              </p>
              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label
                    htmlFor="onboarding-daily-input"
                    className="block text-xs text-fg-muted mb-1"
                  >
                    Daily input token limit
                  </label>
                  <Input
                    id="onboarding-daily-input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.dailyInputTokenLimit}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        dailyInputTokenLimit: e.target.value,
                      }))
                    }
                    placeholder="Platform default"
                  />
                </div>
                <div>
                  <label
                    htmlFor="onboarding-daily-output"
                    className="block text-xs text-fg-muted mb-1"
                  >
                    Daily output token limit
                  </label>
                  <Input
                    id="onboarding-daily-output"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.dailyOutputTokenLimit}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        dailyOutputTokenLimit: e.target.value,
                      }))
                    }
                    placeholder="Platform default"
                  />
                </div>
                <div>
                  <label
                    htmlFor="onboarding-monthly-cap"
                    className="block text-xs text-fg-muted mb-1"
                  >
                    Monthly cost cap (USD)
                  </label>
                  <Input
                    id="onboarding-monthly-cap"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={form.monthlyCostCapUsd}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        monthlyCostCapUsd: e.target.value,
                      }))
                    }
                    placeholder="No cap"
                  />
                </div>
              </div>
            </div>
          )}

          <ActionButton
            onClick={onAction}
            loading={loading}
            disabled={actionDisabled}
            label={actionLabel}
          />
        </>
      );
    }

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

    case 'cloud-byoc': {
      const cloudDisabled =
        form.cloudProvider === 'hetzner'
          ? !form.hetznerToken.trim()
          : !form.scalewaySecretKey.trim() || !form.scalewayProjectId.trim();

      return (
        <>
          {/* Provider toggle */}
          <div className="mb-3">
            <span
              id="onboarding-cloud-group-label"
              className="block text-xs font-medium text-fg-muted mb-1.5"
            >
              Cloud provider
            </span>
            <div
              role="group"
              aria-labelledby="onboarding-cloud-group-label"
              className="flex gap-2 flex-wrap"
            >
              {(['hetzner', 'scaleway'] as const).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  aria-pressed={form.cloudProvider === provider}
                  onClick={() => setForm((prev) => ({ ...prev, cloudProvider: provider }))}
                  className={`px-3 py-2.5 rounded text-xs border cursor-pointer transition-colors min-h-[44px] capitalize ${
                    form.cloudProvider === provider
                      ? 'border-accent bg-accent/10 text-fg-primary'
                      : 'border-border-default bg-surface text-fg-muted hover:border-fg-muted'
                  }`}
                >
                  {provider}
                </button>
              ))}
            </div>
          </div>

          {form.cloudProvider === 'hetzner' ? (
            <div className="mb-3">
              <label
                htmlFor="onboarding-hetzner-token"
                className="block text-xs font-medium text-fg-muted mb-1"
              >
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
          ) : (
            <>
              <div className="mb-3">
                <label
                  htmlFor="onboarding-scaleway-secret"
                  className="block text-xs font-medium text-fg-muted mb-1"
                >
                  Scaleway secret key
                </label>
                <Input
                  id="onboarding-scaleway-secret"
                  type="password"
                  autoComplete="off"
                  value={form.scalewaySecretKey}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, scalewaySecretKey: e.target.value }))
                  }
                  placeholder="Paste your secret key"
                />
              </div>
              <div className="mb-3">
                <label
                  htmlFor="onboarding-scaleway-project"
                  className="block text-xs font-medium text-fg-muted mb-1"
                >
                  Scaleway project ID
                </label>
                <Input
                  id="onboarding-scaleway-project"
                  type="text"
                  autoComplete="off"
                  value={form.scalewayProjectId}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, scalewayProjectId: e.target.value }))
                  }
                  placeholder="Paste your project ID"
                />
                <a
                  href="https://console.scaleway.com/iam/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline mt-1 inline-block"
                >
                  Generate an API key in IAM → API Keys
                </a>
              </div>
            </>
          )}

          <ActionButton
            onClick={onAction}
            loading={loading}
            disabled={cloudDisabled}
            label={actionLabel}
          />
        </>
      );
    }

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
      if (hostedRepo) {
        return (
          <>
            <div className="mb-3">
              <label
                htmlFor="onboarding-hosted-project-name"
                className="block text-xs font-medium text-fg-muted mb-1"
              >
                Project name
              </label>
              <Input
                id="onboarding-hosted-project-name"
                value={form.hostedProjectName}
                maxLength={100}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, hostedProjectName: e.target.value }))
                }
                placeholder="my-first-project"
              />
            </div>
            <ActionButton
              onClick={onCreateProject}
              loading={loading}
              disabled={!form.hostedProjectName.trim()}
              label={actionLabel}
            />
          </>
        );
      }
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
