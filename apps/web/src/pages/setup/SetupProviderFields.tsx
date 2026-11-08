import type { PlatformIntegrationConfigInput } from '../../lib/api';

export type SetupProvider = 'github' | 'google' | 'gitlab';

export interface SetupProviderValues {
  provider: SetupProvider;
  clientId: string;
  clientSecret: string;
  host: string;
}

export const EMPTY_PROVIDER_VALUES: SetupProviderValues = {
  provider: 'github',
  clientId: '',
  clientSecret: '',
  host: 'https://gitlab.com',
};

const PROVIDERS: Array<{ key: SetupProvider; label: string; console: string }> = [
  {
    key: 'github',
    label: 'GitHub',
    console: 'GitHub → Settings → Developer settings → OAuth Apps',
  },
  {
    key: 'google',
    label: 'Google',
    console: 'Google Cloud console → APIs & Services → Credentials',
  },
  { key: 'gitlab', label: 'GitLab', console: 'GitLab → Preferences → Applications' },
];

/** Something was typed for the chosen provider, but not everything it needs. */
export function providerValuesPartial(values: SetupProviderValues): boolean {
  return (
    Boolean(values.clientId.trim() || values.clientSecret.trim()) && !providerValuesComplete(values)
  );
}

/** Every field the chosen provider needs is filled in. */
export function providerValuesComplete(values: SetupProviderValues): boolean {
  return Boolean(
    values.clientId.trim() &&
    values.clientSecret.trim() &&
    (values.provider !== 'gitlab' || values.host.trim())
  );
}

/** The setup request's config for the chosen provider; empty when nothing was entered. */
export function providerConfig(values: SetupProviderValues): PlatformIntegrationConfigInput {
  if (!values.clientId.trim() && !values.clientSecret.trim()) return {};
  const credentials = {
    clientId: values.clientId.trim(),
    clientSecret: values.clientSecret.trim(),
  };
  if (values.provider === 'gitlab') return { gitlab: { ...credentials, host: values.host.trim() } };
  return { [values.provider]: credentials };
}

interface SetupProviderFieldsProps {
  values: SetupProviderValues;
  onChange: (values: SetupProviderValues) => void;
  apiOrigin: string;
}

/**
 * One OAuth sign-in provider for first-run setup. More providers, the GitHub App and the rest
 * of the integration settings live in Admin → Integrations once someone can sign in.
 */
export function SetupProviderFields({ values, onChange, apiOrigin }: SetupProviderFieldsProps) {
  const consolePath = PROVIDERS.find((provider) => provider.key === values.provider)?.console;
  const callbackUrl = `${apiOrigin}/api/auth/callback/${values.provider}`;
  const update = (patch: Partial<SetupProviderValues>) => onChange({ ...values, ...patch });

  return (
    <div className="space-y-4">
      <div
        role="group"
        aria-label="Sign-in provider"
        className="sam-well flex rounded-[var(--sam-radius-control)] p-1"
      >
        {PROVIDERS.map((provider) => {
          const selected = provider.key === values.provider;
          return (
            <button
              key={provider.key}
              type="button"
              aria-pressed={selected}
              onClick={() => update({ provider: provider.key, clientId: '', clientSecret: '' })}
              className={`min-h-11 flex-1 rounded-[calc(var(--sam-radius-control)-4px)] text-sm font-semibold transition-colors ${
                selected ? 'sam-raised text-fg-primary' : 'text-fg-muted hover:text-fg-primary'
              }`}
            >
              {provider.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 text-sm">
        <p className="text-fg-muted">
          Create an OAuth app in <span className="text-fg-primary">{consolePath}</span> with this
          callback URL:
        </p>
        <code className="sam-well block break-all rounded-[var(--sam-radius-control)] px-3 py-2 font-mono text-xs text-fg-primary">
          {callbackUrl}
        </code>
      </div>

      {values.provider === 'gitlab' && (
        <SetupField
          label="GitLab URL"
          value={values.host}
          onChange={(host) => update({ host })}
          placeholder="https://gitlab.com"
          type="url"
        />
      )}
      <SetupField
        label="Client ID"
        value={values.clientId}
        onChange={(clientId) => update({ clientId })}
        autoComplete="off"
      />
      <SetupField
        label="Client secret"
        value={values.clientSecret}
        onChange={(clientSecret) => update({ clientSecret })}
        type="password"
        autoComplete="new-password"
      />
    </div>
  );
}

interface SetupFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password' | 'url' | 'email';
  placeholder?: string;
  autoComplete?: string;
}

function SetupField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
}: SetupFieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-fg-primary">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className="sam-well min-h-12 w-full rounded-[var(--sam-radius-control)] border-0 bg-transparent px-3.5 py-2.5 text-base text-fg-primary placeholder:text-fg-muted focus:outline focus:outline-2 focus:outline-[var(--sam-color-focus-ring)] sm:text-sm"
      />
    </label>
  );
}
