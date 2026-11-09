import type { AgentType } from '@simple-agent-manager/shared';
import { AGENT_CATALOG, getAgentDefinition } from '@simple-agent-manager/shared';
import { Button, SegmentedControl } from '@simple-agent-manager/ui';
import { ArrowRight } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import { FieldLabel, WELL_INPUT_CLASS } from './OnboardingParts';
import { type AuthMethod, authMethodsForAgent, type StepFormState } from './step-actions';
import { SubscriptionConnect } from './SubscriptionConnect';

const AUTH_METHOD_LABEL: Record<AuthMethod, string> = {
  'oauth-token': 'Subscription',
  'api-key': 'API key',
  sam: 'SAM-managed AI',
};

function authMethodLabel(agentId: string, method: AuthMethod): string {
  if (method === 'oauth-token' && agentId === 'openai-codex') return 'ChatGPT plan';
  return AUTH_METHOD_LABEL[method];
}

interface AgentStepProps {
  form: StepFormState;
  setForm: Dispatch<SetStateAction<StepFormState>>;
  /** SAM-managed AI is enabled on this installation. */
  samAvailable: boolean;
  saving: boolean;
  onSave: () => void;
  /** The guided sign-in saved a credential itself. */
  onConnected: () => void;
}

/** Pick an agent, then sign it in: the subscription first, an API key or SAM-managed AI after. */
export function AgentStep({
  form,
  setForm,
  samAvailable,
  saving,
  onSave,
  onConnected,
}: AgentStepProps) {
  const agentId = form.selectedAgent;
  const agentDef = agentId ? getAgentDefinition(agentId as AgentType) : undefined;
  const methods = agentId ? authMethodsForAgent(agentId, { samAvailable }) : [];
  const method = form.selectedAuthMethod;

  // A new agent starts on its first (quickest) way in and forgets any secret typed for another.
  const selectAgent = (id: AgentType) => {
    setForm((prev) => ({
      ...prev,
      selectedAgent: id,
      selectedAuthMethod: authMethodsForAgent(id, { samAvailable })[0] ?? null,
      apiKey: '',
      oauthToken: '',
    }));
  };

  const saveDisabled = !agentId || !method || (method === 'api-key' && !form.apiKey.trim());

  return (
    <div>
      <div role="group" aria-label="Coding agent" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {AGENT_CATALOG.map((agent) => {
          const selected = agentId === agent.id;
          return (
            <button
              key={agent.id}
              type="button"
              aria-pressed={selected}
              onClick={() => selectAgent(agent.id)}
              className={`sam-raised min-h-11 min-w-0 cursor-pointer rounded-[var(--sam-radius-control)] border-0 px-3 py-2.5 text-left transition-[filter,box-shadow] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                selected
                  ? 'shadow-[var(--sam-shadow-glow-active)] ring-1 ring-[var(--sam-status-success-fg)]'
                  : ''
              }`}
            >
              <span className="block break-words text-sm font-semibold text-fg-primary">
                {agent.name}
              </span>
            </button>
          );
        })}
      </div>

      {agentId && methods.length > 1 && (
        <SegmentedControl
          className="mt-4"
          size="lg"
          label="How should it sign in?"
          value={method ?? methods[0] ?? 'api-key'}
          onChange={(value) =>
            setForm((prev) => ({ ...prev, selectedAuthMethod: value, apiKey: '', oauthToken: '' }))
          }
          options={methods.map((m) => ({ value: m, label: authMethodLabel(agentId, m) }))}
        />
      )}

      <div className="mt-4">
        {method === 'oauth-token' && agentDef?.oauthSupport && agentId && (
          <SubscriptionConnect
            agentId={agentId}
            oauthSupport={agentDef.oauthSupport}
            token={form.oauthToken}
            onTokenChange={(value) => setForm((prev) => ({ ...prev, oauthToken: value }))}
            onConnected={onConnected}
          />
        )}

        {method === 'api-key' && agentDef && (
          <div className="mb-3">
            <FieldLabel htmlFor="onboarding-api-key">{agentDef.name} API key</FieldLabel>
            <input
              id="onboarding-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder="Paste your API key"
              className={`${WELL_INPUT_CLASS} font-mono`}
            />
            <a
              href={agentDef.credentialHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block text-xs text-accent hover:underline"
            >
              Where do I find it?
            </a>
          </div>
        )}

        {method === 'sam' && <SamBudget form={form} setForm={setForm} />}
      </div>

      {/* With a subscription the guided sign-in is the action; saving appears once a token is pasted. */}
      {agentId && !(method === 'oauth-token' && !form.oauthToken.trim()) && (
        <Button
          variant="accent"
          size="lg"
          className="mt-2 w-full sm:w-auto"
          onClick={onSave}
          disabled={saveDisabled}
          loading={saving}
        >
          {method === 'oauth-token' ? 'Save sign-in' : 'Use this agent'}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/** SAM-managed AI: usage is billed per task, with optional limits. */
function SamBudget({
  form,
  setForm,
}: {
  form: StepFormState;
  setForm: Dispatch<SetStateAction<StepFormState>>;
}) {
  const fields = [
    { id: 'onboarding-daily-input', key: 'dailyInputTokenLimit', label: 'Daily input tokens' },
    { id: 'onboarding-daily-output', key: 'dailyOutputTokenLimit', label: 'Daily output tokens' },
    { id: 'onboarding-monthly-cap', key: 'monthlyCostCapUsd', label: 'Monthly cap (USD)' },
  ] as const;
  return (
    <div className="mb-3">
      <p className="mb-3 mt-0 text-sm text-fg-muted">
        I route this agent through SAM&apos;s AI proxy and bill usage per task. Limits are optional;
        leave them empty for the defaults.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {fields.map((field) => (
          <div key={field.id}>
            <FieldLabel htmlFor={field.id}>{field.label}</FieldLabel>
            <input
              id={field.id}
              type="number"
              inputMode="numeric"
              min={0}
              value={form[field.key]}
              onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.key === 'monthlyCostCapUsd' ? 'No cap' : 'Default'}
              className={WELL_INPUT_CLASS}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
