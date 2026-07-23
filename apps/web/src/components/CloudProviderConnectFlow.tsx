import type {
  CreateCredentialRequest,
  CredentialProvider,
} from '@simple-agent-manager/shared';
import {
  CREDENTIAL_PROVIDERS,
  PROVIDER_HELP,
  PROVIDER_LABELS,
} from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useToast } from '../hooks/useToast';
import { createCredential, saveProjectCloudCredential } from '../lib/api';

interface CloudProviderConnectFlowProps {
  projectId?: string;
  initialProvider?: string;
  mode?: 'connect' | 'replace' | 'project-override';
  onConnected?: () => void;
  onCancel?: () => void;
}

type CloudFormState = {
  token: string;
  secretKey: string;
  projectId: string;
  gcpProjectId: string;
  gcpProjectNumber: string;
  serviceAccountEmail: string;
  wifPoolId: string;
  wifProviderId: string;
  defaultZone: string;
};

const EMPTY_FORM: CloudFormState = {
  token: '',
  secretKey: '',
  projectId: '',
  gcpProjectId: '',
  gcpProjectNumber: '',
  serviceAccountEmail: '',
  wifPoolId: '',
  wifProviderId: '',
  defaultZone: '',
};

function isCredentialProvider(value: string | undefined): value is CredentialProvider {
  return Boolean(value && (CREDENTIAL_PROVIDERS as readonly string[]).includes(value));
}

function getFlowVerb(mode: CloudProviderConnectFlowProps['mode']): string {
  if (mode === 'replace') return 'Replace';
  if (mode === 'project-override') return 'Save override';
  return 'Connect';
}

function getSuccessMessage(
  provider: CredentialProvider,
  mode: CloudProviderConnectFlowProps['mode'],
  isProjectScoped: boolean
): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  if (isProjectScoped) return `${label} saved for this project`;
  return `${label} ${mode === 'replace' ? 'replaced' : 'connected'}`;
}

function buildRequest(provider: CredentialProvider, form: CloudFormState): CreateCredentialRequest {
  if (provider === 'hetzner') {
    return { provider, token: form.token.trim() };
  }
  if (provider === 'vultr') {
    return { provider, token: form.token.trim() };
  }
  if (provider === 'scaleway') {
    return {
      provider,
      secretKey: form.secretKey.trim(),
      projectId: form.projectId.trim(),
    };
  }
  return {
    provider,
    gcpProjectId: form.gcpProjectId.trim(),
    gcpProjectNumber: form.gcpProjectNumber.trim(),
    serviceAccountEmail: form.serviceAccountEmail.trim(),
    wifPoolId: form.wifPoolId.trim(),
    wifProviderId: form.wifProviderId.trim(),
    defaultZone: form.defaultZone.trim(),
  };
}

function isReady(provider: CredentialProvider | '', form: CloudFormState): boolean {
  if (provider === 'hetzner') return form.token.trim().length > 0;
  if (provider === 'vultr') return form.token.trim().length > 0;
  if (provider === 'scaleway') {
    return form.secretKey.trim().length > 0 && form.projectId.trim().length > 0;
  }
  if (provider === 'gcp') {
    return (
      form.gcpProjectId.trim().length > 0 &&
      form.gcpProjectNumber.trim().length > 0 &&
      form.serviceAccountEmail.trim().length > 0 &&
      form.wifPoolId.trim().length > 0 &&
      form.wifProviderId.trim().length > 0 &&
      form.defaultZone.trim().length > 0
    );
  }
  return false;
}

export function CloudProviderConnectFlow({
  projectId,
  initialProvider,
  mode = projectId ? 'project-override' : 'connect',
  onConnected,
  onCancel,
}: CloudProviderConnectFlowProps) {
  const toast = useToast();
  const [provider, setProvider] = useState<CredentialProvider | ''>(
    isCredentialProvider(initialProvider) ? initialProvider : ''
  );
  const [form, setForm] = useState<CloudFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedHelp = provider ? PROVIDER_HELP[provider] : null;
  const flowVerb = getFlowVerb(mode);

  const setField = (field: keyof CloudFormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
  };

  const handleSave = async () => {
    if (!provider || !isReady(provider, form)) return;
    setSaving(true);
    setError(null);
    const request = buildRequest(provider, form);

    try {
      const response = projectId
        ? await saveProjectCloudCredential(projectId, request)
        : await createCredential(request);
      if (response.validation?.valid === false) {
        toast.warning(`${PROVIDER_LABELS[provider]} saved with a validation warning`);
      } else {
        toast.success(getSuccessMessage(provider, mode, Boolean(projectId)));
      }
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save cloud provider credential');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-fg-muted">Cloud provider</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {CREDENTIAL_PROVIDERS.map((item) => {
            const isSelected = provider === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  setProvider(item);
                  setForm(EMPTY_FORM);
                  setError(null);
                }}
                className={`p-2.5 rounded-md text-left transition-all ${
                  isSelected
                    ? 'border-2 border-accent bg-accent-tint'
                    : 'border border-border-default bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)]'
                } cursor-pointer`}
              >
                <div className="text-sm font-medium text-fg-primary">{PROVIDER_LABELS[item]}</div>
                <div className="text-xs text-fg-muted mt-0.5">{PROVIDER_HELP[item].description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {provider && (
        <>
          {selectedHelp && (
            <p className="m-0 text-xs text-fg-muted">
              Get credentials from{' '}
              <a
                href={selectedHelp.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent"
              >
                {PROVIDER_LABELS[provider]} console
              </a>
            </p>
          )}

          {provider === 'hetzner' && (
            <CredentialInput
              id="cloud-hetzner-token"
              label="Hetzner API token"
              value={form.token}
              onChange={(value) => setField('token', value)}
              placeholder="Hetzner API token"
            />
          )}

          {provider === 'vultr' && (
            <CredentialInput
              id="cloud-vultr-token"
              label="Vultr API key (set Access Control to Allow All IPv4/IPv6)"
              value={form.token}
              onChange={(value) => setField('token', value)}
              placeholder="Vultr Personal Access Token"
            />
          )}

          {provider === 'scaleway' && (
            <>
              <CredentialInput
                id="cloud-scaleway-secret"
                label="Scaleway secret key"
                value={form.secretKey}
                onChange={(value) => setField('secretKey', value)}
                placeholder="Scaleway secret key"
              />
              <TextInput
                id="cloud-scaleway-project"
                label="Scaleway project ID"
                value={form.projectId}
                onChange={(value) => setField('projectId', value)}
                placeholder="Project ID"
              />
            </>
          )}

          {provider === 'gcp' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <TextInput
                id="cloud-gcp-project-id"
                label="GCP project ID"
                value={form.gcpProjectId}
                onChange={(value) => setField('gcpProjectId', value)}
                placeholder="my-gcp-project"
              />
              <TextInput
                id="cloud-gcp-project-number"
                label="GCP project number"
                value={form.gcpProjectNumber}
                onChange={(value) => setField('gcpProjectNumber', value)}
                placeholder="123456789012"
              />
              <TextInput
                id="cloud-gcp-service-account"
                label="Service account email"
                value={form.serviceAccountEmail}
                onChange={(value) => setField('serviceAccountEmail', value)}
                placeholder="sam@example.iam.gserviceaccount.com"
              />
              <TextInput
                id="cloud-gcp-pool"
                label="WIF pool ID"
                value={form.wifPoolId}
                onChange={(value) => setField('wifPoolId', value)}
                placeholder="sam-pool"
              />
              <TextInput
                id="cloud-gcp-provider"
                label="WIF provider ID"
                value={form.wifProviderId}
                onChange={(value) => setField('wifProviderId', value)}
                placeholder="sam-provider"
              />
              <TextInput
                id="cloud-gcp-zone"
                label="Default zone"
                value={form.defaultZone}
                onChange={(value) => setField('defaultZone', value)}
                placeholder="us-central1-a"
              />
            </div>
          )}

          <div className="flex gap-2 justify-end">
            {onCancel && (
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={saving || !isReady(provider, form)}
              onClick={() => void handleSave()}
            >
              {flowVerb}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function TextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
      {label}
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function CredentialInput(props: React.ComponentProps<typeof TextInput>) {
  return (
    <label htmlFor={props.id} className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
      {props.label}
      <Input
        id={props.id}
        type="password"
        autoComplete="off"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.placeholder}
      />
    </label>
  );
}
