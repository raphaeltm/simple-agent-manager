import { AlertCircle, CheckCircle2, KeyRound, Trash2 } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type {
  FeedbackProjectStatus,
  PlatformConfigFieldStatus,
  PlatformConfigStatus,
  PlatformIntegrationConfigInput,
  PlatformIntegrationGroup,
  PlatformIntegrationStatus,
} from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import {
  FieldAudit,
  FieldLabel,
  sharedAuditField,
  SourceBadge,
  TextAreaField,
  TextField,
} from './PlatformIntegrationFields';

type FormValues = Record<string, string>;
type FeedbackProjectOption = { id: string; name: string; status?: string | null };

interface PlatformIntegrationConfigFormProps {
  status: PlatformConfigStatus;
  primaryLabel: string;
  submitting?: boolean;
  /** Resolves `false` when the save failed (the caller shows the error). */
  onPrimary: (config: PlatformIntegrationConfigInput) => Promise<boolean | void> | boolean | void;
  feedbackProjects?: FeedbackProjectOption[];
  feedbackProjectsFooter?: ReactNode;
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
  primaryLabel,
  submitting = false,
  onPrimary,
  feedbackProjects = [],
  feedbackProjectsFooter,
}: PlatformIntegrationConfigFormProps) {
  const [values, setValues] = useState<FormValues>({});
  const [clearTarget, setClearTarget] = useState<PlatformIntegrationGroup | null>(null);
  const [clearFailed, setClearFailed] = useState(false);
  const config = useMemo(() => buildConfig(values), [values]);

  const updateValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await onPrimary(config);
  };

  const handleClear = async () => {
    if (!clearTarget) return;
    const group = clearTarget;
    setClearFailed(false);
    const result = await onPrimary({ clear: [group] });
    if (result === false) {
      // Keep the dialog and any typed values so the admin can retry; nothing was changed.
      setClearFailed(true);
      return;
    }
    setClearTarget(null);
    // Drop any half-typed replacement for the cleared group so it cannot be saved by accident.
    setValues((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !GROUP_FIELD_PREFIXES[group].includes(key))
      )
    );
    // The Clear button unmounts with the stored values; keep focus in the cleared card.
    requestAnimationFrame(() => document.getElementById(sectionHeadingId(group))?.focus());
  };

  const closeClearDialog = () => {
    setClearTarget(null);
    setClearFailed(false);
  };

  const sharedAudits = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(status.integrations).map(([group, integration]) => [
          group,
          sharedAuditField(integration.fields),
        ])
      ) as Record<PlatformIntegrationGroup, PlatformConfigFieldStatus | null>,
    [status.integrations]
  );

  const sectionProps = (group: PlatformIntegrationGroup) => ({
    sharedAudit: sharedAudits[group],
    group,
    title: GROUP_TITLES[group],
    status: status.integrations[group],
    submitting,
    onClear: setClearTarget,
  });

  return (
    <form className="space-y-4" onSubmit={handleSubmit} data-testid="platform-config-form">
      <div className="grid gap-4 md:grid-cols-2">
        <IntegrationSection
          {...sectionProps('githubOAuth')}
          description="Enables GitHub sign-in and user GitHub token refresh."
        >
          <TextField
            name="github.clientId"
            label={FIELD_LABELS.clientId}
            value={values['github.clientId'] ?? ''}
            field={status.integrations.githubOAuth.fields.clientId}
            onChange={updateValue}
            showAudit={!sharedAudits.githubOAuth}
          />
          <TextField
            name="github.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['github.clientSecret'] ?? ''}
            field={status.integrations.githubOAuth.fields.clientSecret}
            onChange={updateValue}
            showAudit={!sharedAudits.githubOAuth}
          />
        </IntegrationSection>

        <IntegrationSection
          {...sectionProps('googleOAuth')}
          description="A dedicated Google OAuth client for user login — separate from any Google/GCP infrastructure credentials. Register the redirect URI /api/auth/callback/google on this client."
        >
          <TextField
            name="google.clientId"
            label={FIELD_LABELS.clientId}
            value={values['google.clientId'] ?? ''}
            field={status.integrations.googleOAuth.fields.clientId}
            onChange={updateValue}
            showAudit={!sharedAudits.googleOAuth}
          />
          <TextField
            name="google.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['google.clientSecret'] ?? ''}
            field={status.integrations.googleOAuth.fields.clientSecret}
            onChange={updateValue}
            showAudit={!sharedAudits.googleOAuth}
          />
        </IntegrationSection>

        <IntegrationSection
          {...sectionProps('googleInfrastructureOAuth')}
          description="Used only for keyless GCP/WIF setup with cloud-platform scope. Register both static callbacks: /auth/google/callback and /api/deployment/gcp/callback. This client never enables Google sign-in."
        >
          <TextField
            name="googleInfrastructure.clientId"
            label={FIELD_LABELS.clientId}
            value={values['googleInfrastructure.clientId'] ?? ''}
            field={status.integrations.googleInfrastructureOAuth.fields.clientId}
            onChange={updateValue}
            showAudit={!sharedAudits.googleInfrastructureOAuth}
          />
          <TextField
            name="googleInfrastructure.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['googleInfrastructure.clientSecret'] ?? ''}
            field={status.integrations.googleInfrastructureOAuth.fields.clientSecret}
            onChange={updateValue}
            showAudit={!sharedAudits.googleInfrastructureOAuth}
          />
          <p className="text-xs text-fg-muted">
            Enter both values to configure or rotate the client. Secrets are encrypted and never
            returned.
          </p>
        </IntegrationSection>

        <IntegrationSection
          {...sectionProps('gitlabOAuth')}
          description="Stores the GitLab OAuth application for GitLab sign-in."
        >
          <TextField
            name="gitlab.host"
            label={FIELD_LABELS.host}
            value={values['gitlab.host'] ?? ''}
            field={status.integrations.gitlabOAuth.fields.host}
            onChange={updateValue}
            showAudit={!sharedAudits.gitlabOAuth}
          />
          <TextField
            name="gitlab.clientId"
            label={FIELD_LABELS.clientId}
            value={values['gitlab.clientId'] ?? ''}
            field={status.integrations.gitlabOAuth.fields.clientId}
            onChange={updateValue}
            showAudit={!sharedAudits.gitlabOAuth}
          />
          <TextField
            name="gitlab.clientSecret"
            label={FIELD_LABELS.clientSecret}
            type="password"
            value={values['gitlab.clientSecret'] ?? ''}
            field={status.integrations.gitlabOAuth.fields.clientSecret}
            onChange={updateValue}
            showAudit={!sharedAudits.gitlabOAuth}
          />
        </IntegrationSection>
      </div>

      <FeedbackProjectSection
        status={status.feedbackProject}
        projects={feedbackProjects}
        footer={feedbackProjectsFooter}
        value={values['feedback.projectId'] ?? status.feedbackProject.projectId ?? ''}
        onChange={(value) => updateValue('feedback.projectId', value)}
      />

      <IntegrationSection
        {...sectionProps('githubApp')}
        description="Connects repository installation, webhooks, task dispatch, and project automation."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            name="github.appId"
            label={FIELD_LABELS.appId}
            value={values['github.appId'] ?? ''}
            field={status.integrations.githubApp.fields.appId}
            onChange={updateValue}
            showAudit={!sharedAudits.githubApp}
          />
          <TextField
            name="github.appSlug"
            label={FIELD_LABELS.appSlug}
            value={values['github.appSlug'] ?? ''}
            field={status.integrations.githubApp.fields.appSlug}
            onChange={updateValue}
            showAudit={!sharedAudits.githubApp}
          />
        </div>
        <TextAreaField
          name="github.appPrivateKey"
          label={FIELD_LABELS.appPrivateKey}
          value={values['github.appPrivateKey'] ?? ''}
          field={status.integrations.githubApp.fields.appPrivateKey}
          onChange={updateValue}
          showAudit={!sharedAudits.githubApp}
        />
      </IntegrationSection>

      <IntegrationSection
        {...sectionProps('githubWebhook')}
        description="Verifies inbound GitHub webhook signatures before automation runs."
      >
        <TextField
          name="github.webhookSecret"
          label={FIELD_LABELS.webhookSecret}
          type="password"
          value={values['github.webhookSecret'] ?? ''}
          field={status.integrations.githubWebhook.fields.webhookSecret}
          onChange={updateValue}
          showAudit={!sharedAudits.githubWebhook}
        />
      </IntegrationSection>

      <ConfirmDialog
        isOpen={clearTarget !== null}
        onClose={closeClearDialog}
        onConfirm={() => void handleClear()}
        title={clearTarget ? `Clear ${GROUP_TITLES[clearTarget]}?` : 'Clear integration?'}
        message={clearTarget ? <ClearMessage group={clearTarget} failed={clearFailed} /> : ''}
        confirmLabel="Clear stored values"
        variant="danger"
        loading={submitting}
      />

      <div className="flex flex-col gap-2 border-t border-border-default pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-fg-muted">
          Values stored in SAM override Worker environment fallbacks.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={submitting}
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
  group,
  submitting = false,
  onClear,
  sharedAudit = null,
}: {
  title: string;
  description: string;
  status: PlatformIntegrationStatus | FeedbackProjectStatus;
  children: ReactNode;
  /** When set, the section offers "Clear stored values" for this integration group. */
  group?: PlatformIntegrationGroup;
  submitting?: boolean;
  onClear?: (group: PlatformIntegrationGroup) => void;
  /** One "changed by" line for the whole card when every stored field shares it. */
  sharedAudit?: PlatformConfigFieldStatus | null;
}) {
  const clearable = Boolean(group && onClear && 'clearable' in status && status.clearable);
  return (
    <section
      className="min-w-0 rounded-lg border border-border-default bg-surface p-4"
      data-testid={`integration-${title.toLowerCase().replaceAll(' ', '-')}`}
    >
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id={group ? sectionHeadingId(group) : undefined}
              tabIndex={group ? -1 : undefined}
              className="text-base font-semibold text-fg-primary focus:outline-none"
            >
              {title}
            </h2>
            <SourceBadge label={status.label} configured={status.configured} />
          </div>
          <p className="mt-1 break-words text-sm text-fg-muted">{description}</p>
          {sharedAudit && (
            <div className="mt-1">
              <FieldAudit field={sharedAudit} testId="platform-section-audit" />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
          {status.configured ? (
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-4 w-4 text-warning" aria-hidden="true" />
          )}
          {status.configured ? 'Configured' : 'Incomplete'}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
      {clearable && group && onClear && (
        <div className="mt-4 flex flex-col gap-2 border-t border-border-default pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-fg-muted">
            Remove the values stored in SAM. Environment values, if any, take over.
          </p>
          <button
            type="button"
            onClick={() => onClear(group)}
            disabled={submitting}
            aria-label={`Clear stored ${title} values`}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 self-start rounded-md border border-danger/40 px-4 sm:self-auto text-sm font-semibold text-danger hover:bg-danger-tint disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Clear
          </button>
        </div>
      )}
    </section>
  );
}

function FeedbackProjectSection({
  footer,
  status,
  projects,
  value,
  onChange,
}: {
  footer?: ReactNode;
  status: FeedbackProjectStatus;
  projects: FeedbackProjectOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const projectOptions = [...projects];
  if (status.projectId && !projectOptions.some((project) => project.id === status.projectId)) {
    projectOptions.unshift({
      id: status.projectId,
      name:
        status.project?.name ??
        (status.state === 'missing' ? 'Missing configured project' : 'Configured project'),
      status: status.state,
    });
  }

  return (
    <IntegrationSection
      title="Operations project"
      description="Select the private project that receives Report Issue draft Ideas, automated platform triage and incident trigger agents. Its agents get the incident MCP tools and, when operations.debuggerTools is on, the Operations debugger tools."
      status={status}
    >
      <label className="block space-y-1.5">
        <FieldLabel label="Project" field={status.fields.projectId} />
        <select
          aria-label="Operations project"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary"
        >
          <option value="">Use environment fallback / unset</option>
          {projectOptions.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} — {project.id}
              {project.status && project.status !== 'active' ? ` (${project.status})` : ''}
            </option>
          ))}
        </select>
      </label>
      {footer}
      <p
        className={`rounded-md border px-3 py-2 text-sm ${
          status.state === 'ready'
            ? 'border-success/30 bg-success-tint text-success-fg'
            : 'border-warning/30 bg-warning-tint text-warning-fg'
        }`}
        data-testid="feedback-project-status"
      >
        {status.message}
      </p>
      {status.projectId && (
        <p className="text-xs text-fg-muted">
          Effective project: <span className="font-mono">{status.projectId}</span>
          {status.project?.name ? ` (${status.project.name})` : ''}
        </p>
      )}
      <p className="text-xs text-fg-muted">
        Runtime selection is stored in platform settings and overrides the
        PLATFORM_FEEDBACK_PROJECT_ID environment fallback. Clearing the runtime selection reveals
        that fallback, or hides Report Issue if no fallback is set. Existing incidents are not
        migrated.
      </p>
      <FieldAudit field={status.fields.projectId} testId="feedback-project-audit" />
    </IntegrationSection>
  );
}

const GROUP_TITLES: Record<PlatformIntegrationGroup, string> = {
  githubOAuth: 'GitHub OAuth',
  githubApp: 'GitHub App',
  githubWebhook: 'GitHub Webhooks',
  googleOAuth: 'Google sign-in (OAuth)',
  googleInfrastructureOAuth: 'Google infrastructure OAuth',
  gitlabOAuth: 'GitLab OAuth',
};

/** Form value keys each group owns, so a clear also drops half-typed replacements. */
const GROUP_FIELD_PREFIXES: Record<PlatformIntegrationGroup, string[]> = {
  githubOAuth: ['github.clientId', 'github.clientSecret'],
  githubApp: ['github.appId', 'github.appSlug', 'github.appPrivateKey'],
  githubWebhook: ['github.webhookSecret'],
  googleOAuth: ['google.clientId', 'google.clientSecret'],
  googleInfrastructureOAuth: ['googleInfrastructure.clientId', 'googleInfrastructure.clientSecret'],
  gitlabOAuth: ['gitlab.host', 'gitlab.clientId', 'gitlab.clientSecret'],
};

const SIGN_IN_GROUPS = new Set<PlatformIntegrationGroup>([
  'githubOAuth',
  'googleOAuth',
  'gitlabOAuth',
]);

function ClearMessage({
  group,
  failed,
}: Readonly<{ group: PlatformIntegrationGroup; failed: boolean }>) {
  return (
    <div className="space-y-2">
      <p>
        SAM will delete the {GROUP_TITLES[group]} values stored in its database, including encrypted
        secrets.
      </p>
      <p>Worker environment values, if set, become active again.</p>
      {SIGN_IN_GROUPS.has(group) && (
        <p>Otherwise its sign-in button disappears and nobody can sign in with it.</p>
      )}
      <p>The change is recorded in the settings audit and the owners are emailed.</p>
      {failed && (
        <p role="alert" className="font-medium text-danger">
          Clearing failed and nothing was changed. The error is shown at the top of the page; try
          again.
        </p>
      )}
    </div>
  );
}

function sectionHeadingId(group: PlatformIntegrationGroup): string {
  return `integration-heading-${group}`;
}

function buildConfig(values: FormValues): PlatformIntegrationConfigInput {
  const config: PlatformIntegrationConfigInput = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (key === 'feedback.projectId') {
      config.feedback = trimmed ? { projectId: trimmed } : { remove: true };
      continue;
    }
    if (!trimmed) continue;

    if (key.startsWith('github.')) {
      const field = key.slice('github.'.length) as keyof NonNullable<
        PlatformIntegrationConfigInput['github']
      >;
      config.github = { ...config.github, [field]: trimmed };
    }

    if (key.startsWith('google.')) {
      const field = key.slice('google.'.length) as keyof NonNullable<
        PlatformIntegrationConfigInput['google']
      >;
      config.google = { ...config.google, [field]: trimmed };
    }

    if (key.startsWith('googleInfrastructure.')) {
      const field = key.slice('googleInfrastructure.'.length) as keyof NonNullable<
        PlatformIntegrationConfigInput['googleInfrastructure']
      >;
      config.googleInfrastructure = { ...config.googleInfrastructure, [field]: trimmed };
    }

    if (key.startsWith('gitlab.')) {
      const field = key.slice('gitlab.'.length) as keyof NonNullable<
        PlatformIntegrationConfigInput['gitlab']
      >;
      config.gitlab = { ...config.gitlab, [field]: trimmed };
    }
  }
  return config;
}
