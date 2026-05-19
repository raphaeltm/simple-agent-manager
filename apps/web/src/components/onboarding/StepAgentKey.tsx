import type { AgentType, SaveAgentCredentialRequest } from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { Alert, Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { saveAgentCredential, validateAgentCredential } from '../../lib/api';
import {
  CompleteState,
  getValidateButtonLabel,
  OptionCard,
  StepActions,
  useValidatedCredentialStep,
} from './StepShared';

interface StepAgentKeyProps {
  onComplete: () => void;
  onSkip: () => void;
  isComplete: boolean;
}

export function StepAgentKey({ onComplete, onSkip, isComplete }: StepAgentKeyProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentType | null>(null);
  const [apiKey, setApiKey] = useState('');
  const credentialRequest: SaveAgentCredentialRequest | null =
    selectedAgent && apiKey.trim()
      ? {
          agentType: selectedAgent,
          credentialKind: 'api-key',
          credential: apiKey.trim(),
        }
      : null;
  const {
    error,
    handleSave,
    handleValidate,
    isValidated,
    resetValidation,
    saving,
    setError,
    validating,
    validationMessage,
  } = useValidatedCredentialStep({
    missingRequestMessage: 'Select an agent and enter an API key',
    onSaved: onComplete,
    request: credentialRequest,
    saveErrorMessage: 'Failed to save API key',
    saveRequest: saveAgentCredential,
    validateErrorMessage: 'API key validation failed',
    validateRequest: validateAgentCredential,
  });

  const selectedDef = selectedAgent ? AGENT_CATALOG.find((a) => a.id === selectedAgent) : null;

  if (isComplete) {
    return (
      <CompleteState
        title="AI agent connected"
        description="You can manage your agent keys in Settings."
        onContinue={onComplete}
      />
    );
  }

  return (
    <div>
      <h3 className="sam-type-section-heading text-fg-primary m-0 mb-1">Connect your AI agent</h3>
      <p className="sam-type-body text-fg-muted m-0 mb-4">
        SAM runs AI coding agents in cloud workspaces. Which agent do you use?
      </p>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {/* Agent selection grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        {AGENT_CATALOG.map((agent) => (
          <OptionCard
            key={agent.id}
            name={agent.name}
            description={agent.description}
            isSelected={selectedAgent === agent.id}
            onSelect={() => {
              setSelectedAgent(agent.id);
              setError(null);
              resetValidation();
            }}
          />
        ))}
      </div>

      {/* API key input */}
      {selectedDef && (
        <div className="mb-4">
          <label htmlFor="agent-api-key" className="block text-sm font-medium text-fg-primary mb-1">
            {selectedDef.name} API Key
          </label>
          <Input
            id="agent-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              resetValidation();
            }}
            placeholder={`Paste your ${selectedDef.provider} API key`}
          />
          <a
            href={selectedDef.credentialHelpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline mt-1 inline-block"
          >
            Where do I get this?
          </a>
        </div>
      )}

      {validationMessage && (
        <div className="mb-3">
          <Alert variant="success">{validationMessage}</Alert>
        </div>
      )}

      <StepActions
        onSkip={onSkip}
        onValidate={handleValidate}
        onSave={handleSave}
        testDisabled={!selectedAgent || !apiKey.trim() || validating || saving}
        connectDisabled={!selectedAgent || !apiKey.trim() || saving || validating || !isValidated}
        testLabel={getValidateButtonLabel(validating, isValidated, 'Test key')}
        saveLabel={saving ? 'Saving...' : 'Connect'}
      />
    </div>
  );
}
