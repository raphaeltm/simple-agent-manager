import { AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type {
  PlatformConfigFieldStatus,
  PlatformConfigStatus,
  PlatformIntegrationConfigInput,
  PlatformIntegrationStatus,
} from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';

type FormValues = Record<string, string>;

interface PlatformIntegrationConfigFormProps {
  status: PlatformConfigStatus;
  mode: 'setup' | 'admin';
  primaryLabel: string;
  secondaryLabel?: string;
  submitting?: boolean;
  secondarySubmitting?: boolean;
  onPrimary: (config: PlatformIntegrationConfigInput) => Promise<void> | void;
  onSecondary?: (config: PlatformIntegrationConfigInput) => Promise<void> | void;
}

const FIELD_LABELS = {
  host: 'Host URL',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  appId: 'App ID',
  appPrivateKey: 'Private key',
  appSlug: 'App slug',
  webhookSecret: 'Webhook secret',
} as const;

export function PlatformIntegrationConfigForm({
  status,
  mode,
  primaryLabel,
  secondaryLabel,
  submitting = false,
  secondarySubmitting = false,
  onPrimary,
  onSecondary,
}: PlatformIntegrationConfigFormProps) {
  const [values, setValues] = useState<FormValues>({});
  const [showRemoveInfrastructureConfirm, setShowRemoveInfrastructureConfirm] = useState(false);
  const config = useMemo(() => buildConfig(values), [values]);

  const updateValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await onPrimary(config);
  };

  const handleSecondary = async () => {
    if (!onSecondary) return;
    await onSecondary(config);
  };

  const handleRemoveInfrastructure = async () => {
    await onPrimary({ googleInfrastructure: { remove: true } });
    setShowRemoveInfrastructureConfirm(false);
    setValues((current) => {
      const next = { ...current };
      delete next['googleInfrastructure.clientId'];
      delete next['googleInfrastructure.clientSecret'];
      return next;
    });
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit} data-testid="platform-config-form">
      <div className="grid gap-4 md:grid-cols-2">
        <IntegrationSection
          title="GitHub OAuth"
          description="Enables GitHub sign-in and user GitHub token refresh."
          status={status.integrations.githubOAuth}
        >
          <TextField
            name="github.clientId"
            label={FIELD_LABELS.clientId}
            value={values['github.clientId'] ?? ''}
            field={status.integrations.githubOAuth.fields.clientId}
            onChange={updateValue}
          />
          <TextField
            name="github.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['github.clientSecret'] ?? ''}
            field={status.integrations.githubOAuth.fields.clientSecret}
            onChange={updateValue}
          />
        </IntegrationSection>

        <IntegrationSection
          title="Google sign-in (OAuth)"
          description="A dedicated Google OAuth client for user login — separate from any Google/GCP infrastructure credentials. Register the redirect URI /api/auth/callback/google on this client."
          status={status.integrations.googleOAuth}
        >
          <TextField
            name="google.clientId"
            label={FIELD_LABELS.clientId}
            value={values['google.clientId'] ?? ''}
            field={status.integrations.googleOAuth.fields.clientId}
            onChange={updateValue}
          />
          <TextField
            name="google.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['google.clientSecret'] ?? ''}
            field={status.integrations.googleOAuth.fields.clientSecret}
            onChange={updateValue}
          />
        </IntegrationSection>

        {mode === 'admin' && (
          <IntegrationSection
            title="Google infrastructure OAuth"
            description="Used only for keyless GCP/WIF setup with cloud-platform scope. Register both static callbacks: /auth/google/callback and /api/deployment/gcp/callback. This client never enables Google sign-in."
            status={status.integrations.googleInfrastructureOAuth}
          >
            <TextField
              name="googleInfrastructure.clientId"
              label={FIELD_LABELS.clientId}
              value={values['googleInfrastructure.clientId'] ?? ''}
              field={status.integrations.googleInfrastructureOAuth.fields.clientId}
              onChange={updateValue}
            />
            <TextField
              name="googleInfrastructure.clientSecret"
              label={FIELD_LABELS.clientSecret}
              type="password"
              value={values['googleInfrastructure.clientSecret'] ?? ''}
              field={status.integrations.googleInfrastructureOAuth.fields.clientSecret}
              onChange={updateValue}
            />
            <p className="text-xs text-fg-muted">
              Enter both values to configure or rotate the client. Secrets are encrypted and never returned.
            </p>
            <FieldAudit
              field={status.integrations.googleInfrastructureOAuth.fields.clientSecret}
            />
            {status.integrations.googleInfrastructureOAuth.source === 'runtime' && (
              <button
                type="button"
                onClick={() => setShowRemoveInfrastructureConfirm(true)}
                disabled={submitting || secondarySubmitting}
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-danger/40 px-3 text-sm font-semibold text-danger hover:bg-danger-tint disabled:cursor-not-allowed disabled:opacity-60"
              >
                Remove runtime infrastructure client
              </button>
            )}
          </IntegrationSection>
        )}

        <IntegrationSection
          title="GitLab OAuth"
          description="Stores the GitLab OAuth application for GitLab sign-in."
          status={status.integrations.gitlabOAuth}
        >
          <TextField
            name="gitlab.host"
            label={FIELD_LABELS.host}
            value={values['gitlab.host'] ?? ''}
            field={status.integrations.gitlabOAuth.fields.host}
            onChange={updateValue}
          />
          <TextField
            name="gitlab.clientId"
            label={FIELD_LABELS.clientId}
            value={values['gitlab.clientId'] ?? ''}
            field={status.integrations.gitlabOAuth.fields.clientId}
            onChange={updateValue}
          />
          <TextField
            name="gitlab.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['gitlab.clientSecret'] ?? ''}
            field={status.integrations.gitlabOAuth.fields.clientSecret}
            onChange={updateValue}
          />
        </IntegrationSection>
      </div>

      <IntegrationSection
        title="GitHub App"
        description="Connects repository installation, webhooks, task dispatch, and project automation."
        status={status.integrations.githubApp}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            name="github.appId"
            label={FIELD_LABELS.appId}
            value={values['github.appId'] ?? ''}
            field={status.integrations.githubApp.fields.appId}
            onChange={updateValue}
          />
          <TextField
            name="github.appSlug"
            label={FIELD_LABELS.appSlug}
            value={values['github.appSlug'] ?? ''}
            field={status.integrations.githubApp.fields.appSlug}
            onChange={updateValue}
          />
        </div>
        <TextAreaField
          name="github.appPrivateKey"
          label={FIELD_LABELS.appPrivateKey}
          value={values['github.appPrivateKey'] ?? ''}
          field={status.integrations.githubApp.fields.appPrivateKey}
          onChange={updateValue}
        />
      </IntegrationSection>

      <IntegrationSection
        title="GitHub Webhooks"
        description="Verifies inbound GitHub webhook signatures before automation runs."
        status={status.integrations.githubWebhook}
      >
        <TextField
          name="github.webhookSecret"
          label={FIELD_LABELS.webhookSecret}
          type="password"
          value={values['github.webhookSecret'] ?? ''}
          field={status.integrations.githubWebhook.fields.webhookSecret}
          onChange={updateValue}
        />
      </IntegrationSection>

      <ConfirmDialog
        isOpen={showRemoveInfrastructureConfirm}
        onClose={() => setShowRemoveInfrastructureConfirm(false)}
        onConfirm={() => void handleRemoveInfrastructure()}
        title="Remove runtime Google infrastructure OAuth?"
        message="SAM will delete the encrypted runtime client ID and secret. If GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in the environment, that fallback becomes active again."
        confirmLabel="Remove runtime client"
        variant="danger"
        loading={submitting}
      />

      <div className="flex flex-col gap-2 border-t border-border-default pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-fg-muted">
          {mode === 'setup'
            ? 'Setup can finish when at least one sign-in provider is configured.'
            : 'Runtime values override GitHub Actions or Worker environment fallbacks.'}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={handleSecondary}
              disabled={submitting || secondarySubmitting}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-default bg-surface px-4 text-sm font-semibold text-fg-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {secondarySubmitting ? 'Completing...' : secondaryLabel}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || secondarySubmitting}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-transparent bg-accent px-4 text-sm font-semibold text-fg-on-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {submitting ? 'Saving...' : primaryLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function IntegrationSection({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description: string;
  status: PlatformIntegrationStatus;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-lg border border-border-default bg-surface p-4"
      data-testid={`integration-${title.toLowerCase().replaceAll(' ', '-')}`}
    >
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-fg-primary">{title}</h2>
            <SourceBadge label={status.label} configured={status.configured} />
          </div>
          <p className="mt-1 text-sm text-fg-muted">{description}</p>
        </div>
        <div className="flex items-center gap-1 text-xs text-fg-muted">
          {status.configured ? (
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-4 w-4 text-warning" aria-hidden="true" />
          )}
          {status.configured ? 'Configured' : 'Incomplete'}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function TextField({
  name,
  label,
  value,
  field,
  onChange,
  type = 'text',
}: {
  name: string;
  label: string;
  value: string;
  field?: PlatformConfigFieldStatus;
  onChange: (name: string, value: string) => void;
  type?: 'text' | 'password';
}) {
  return (
    <label className="block space-y-1.5">
      <FieldLabel label={label} field={field} />
      <input
        type={type}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={field?.configured ? 'Leave blank to keep current value' : `Enter ${label.toLowerCase()}`}
        className="w-full min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

function TextAreaField({
  name,
  label,
  value,
  field,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  field?: PlatformConfigFieldStatus;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <FieldLabel label={label} field={field} />
      <textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={field?.configured ? 'Leave blank to keep current key' : 'Paste PEM private key'}
        className="min-h-36 w-full resize-y rounded-sm border border-border-default bg-inset px-3 py-2 font-mono text-xs text-fg-primary placeholder:text-fg-muted"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

function FieldAudit({ field }: { field?: PlatformConfigFieldStatus }) {
  if (!field?.updatedAt) return null;
  return (
    <p className="text-xs text-fg-muted" data-testid="google-infrastructure-audit">
      Last rotated {new Date(field.updatedAt).toLocaleString()}
      {field.updatedBy ? ` by ${field.updatedBy}` : ''}
    </p>
  );
}

function FieldLabel({ label, field }: { label: string; field?: PlatformConfigFieldStatus }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-primary">
      {label}
      <SourceBadge label={sourceLabel(field)} configured={Boolean(field?.configured)} compact />
    </span>
  );
}

function SourceBadge({
  label,
  configured,
  compact = false,
}: {
  label: string;
  configured: boolean;
  compact?: boolean;
}) {
  const className = configured
    ? 'border-success/30 bg-success-tint text-success-fg'
    : 'border-border-default bg-surface-secondary text-fg-muted';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 ${compact ? 'py-0 text-[11px]' : 'py-0.5 text-xs'} ${className}`}>
      {label}
    </span>
  );
}

function sourceLabel(field?: PlatformConfigFieldStatus): string {
  if (field?.source === 'runtime') return 'set here';
  if (field?.source === 'environment') return 'set via environment fallback';
  return 'not configured';
}

function buildConfig(values: FormValues): PlatformIntegrationConfigInput {
  const config: PlatformIntegrationConfigInput = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (!trimmed) continue;

    if (key.startsWith('github.')) {
      const field = key.slice('github.'.length) as keyof NonNullable<PlatformIntegrationConfigInput['github']>;
      config.github = { ...config.github, [field]: trimmed };
    }

    if (key.startsWith('google.')) {
      const field = key.slice('google.'.length) as keyof NonNullable<PlatformIntegrationConfigInput['google']>;
      config.google = { ...config.google, [field]: trimmed };
    }

    if (key.startsWith('googleInfrastructure.')) {
      const field = key.slice('googleInfrastructure.'.length) as keyof NonNullable<PlatformIntegrationConfigInput['googleInfrastructure']>;
      config.googleInfrastructure = { ...config.googleInfrastructure, [field]: trimmed };
    }

    if (key.startsWith('gitlab.')) {
      const field = key.slice('gitlab.'.length) as keyof NonNullable<PlatformIntegrationConfigInput['gitlab']>;
      config.gitlab = { ...config.gitlab, [field]: trimmed };
    }
  }
  return config;
}
