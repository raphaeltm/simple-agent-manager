import { Button } from '@simple-agent-manager/ui';
import { useRef, useState } from 'react';

interface CompleteStateProps {
  description: string;
  onContinue: () => void;
  title: string;
}

interface OptionCardProps {
  description: string;
  isSelected: boolean;
  name: string;
  onSelect: () => void;
}

interface StepActionsProps {
  connectDisabled: boolean;
  onSave: () => void;
  onSkip: () => void;
  onValidate: () => void;
  saveLabel: string;
  testDisabled: boolean;
  testLabel: string;
}

interface CredentialValidationResult {
  valid?: boolean;
  message: string;
  error?: string;
}

interface CredentialSaveResult {
  validation?: CredentialValidationResult;
}

interface UseValidatedCredentialStepOptions<TRequest> {
  missingRequestMessage: string;
  onSaved: () => void;
  request: TRequest | null;
  saveErrorMessage: string;
  saveRequest: (request: TRequest) => Promise<CredentialSaveResult | unknown>;
  validateErrorMessage: string;
  validateRequest: (request: TRequest) => Promise<CredentialValidationResult>;
}


function extractCredentialValidation(result: unknown): CredentialValidationResult | null {
  if (!result || typeof result !== 'object') return null;
  const maybeValidation = (result as CredentialSaveResult).validation;
  if (maybeValidation && typeof maybeValidation.message === 'string') {
    return maybeValidation;
  }
  const maybeResult = result as CredentialValidationResult;
  if (typeof maybeResult.message === 'string') {
    return maybeResult;
  }
  return null;
}

export function getValidateButtonLabel(
  validating: boolean,
  isValidated: boolean,
  idleLabel: string
): string {
  if (validating) return 'Testing...';
  if (isValidated) return 'Tested';
  return idleLabel;
}

export function useValidatedCredentialStep<TRequest>({
  missingRequestMessage,
  onSaved,
  request,
  saveErrorMessage,
  saveRequest,
  validateErrorMessage,
  validateRequest,
}: UseValidatedCredentialStepOptions<TRequest>) {
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestCredentialKey = useRef<string | null>(null);
  const credentialKey = request ? JSON.stringify(request) : null;
  latestCredentialKey.current = credentialKey;
  const isValidated = validatedKey === credentialKey && credentialKey !== null;

  const resetValidation = () => {
    setValidatedKey(null);
    setValidationMessage(null);
    setValidationWarning(null);
  };

  const handleValidate = async () => {
    if (!request || !credentialKey) {
      setError(missingRequestMessage);
      return;
    }
    setValidating(true);
    setValidationMessage(null);
    setValidationWarning(null);
    setError(null);
    const requestKey = credentialKey;
    try {
      const result = await validateRequest(request);
      if (latestCredentialKey.current !== requestKey) return;
      setValidatedKey(requestKey);
      setValidationMessage(result.message);
    } catch (err) {
      if (latestCredentialKey.current !== requestKey) return;
      setValidatedKey(null);
      setError(err instanceof Error ? err.message : validateErrorMessage);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    if (!request || !credentialKey) {
      setError(missingRequestMessage);
      return;
    }
    setSaving(true);
    setValidationMessage(null);
    setValidationWarning(null);
    setError(null);
    const requestKey = credentialKey;
    try {
      const result = await saveRequest(request);
      if (latestCredentialKey.current !== requestKey) return;
      const validation = extractCredentialValidation(result);
      setValidatedKey(requestKey);
      if (validation?.valid === false) {
        setValidationWarning(`Saved, but ${validation.error ?? validation.message}`);
        return;
      }
      if (validation?.message) {
        setValidationMessage(validation.message);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : saveErrorMessage);
    } finally {
      setSaving(false);
    }
  };

  return {
    error,
    handleSave,
    handleValidate,
    isValidated,
    resetValidation,
    saving,
    setError,
    validating,
    validationMessage,
    validationWarning,
  };
}

export function CompleteState({ description, onContinue, title }: Readonly<CompleteStateProps>) {
  return (
    <div className="text-center py-6">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-3">
        <span className="text-success text-xl">{'\u2713'}</span>
      </div>
      <p className="sam-type-body text-fg-primary font-medium m-0 mb-1">{title}</p>
      <p className="sam-type-caption text-fg-muted m-0">{description}</p>
      <div className="mt-4">
        <Button variant="primary" size="md" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

export function OptionCard({ description, isSelected, name, onSelect }: Readonly<OptionCardProps>) {
  const stateClass = isSelected
    ? 'border-accent ring-1 ring-accent'
    : 'border-border-default hover:border-fg-muted';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`p-3 rounded-md border text-left transition-colors cursor-pointer bg-surface ${stateClass}`}
    >
      <span className="block font-medium text-sm text-fg-primary">{name}</span>
      <span className="block text-xs text-fg-muted mt-0.5">{description}</span>
    </button>
  );
}

export function StepActions({
  connectDisabled,
  onSave,
  onSkip,
  onValidate,
  saveLabel,
  testDisabled,
  testLabel,
}: Readonly<StepActionsProps>) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <button
        type="button"
        onClick={onSkip}
        className="self-start text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Skip this step
      </button>
      <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
        <Button variant="secondary" size="md" onClick={onValidate} disabled={testDisabled}>
          {testLabel}
        </Button>
        <Button variant="primary" size="md" onClick={onSave} disabled={connectDisabled}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
