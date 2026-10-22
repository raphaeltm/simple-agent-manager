import type { GitHubCliPermissionLevel, GitHubCliPolicy } from '@simple-agent-manager/shared';

import { GITHUB_PERMISSION_ROWS } from './profile-form-options';
import { SELECT_CLASSES, SelectField } from './ProfileFormPrimitives';

interface GitHubCliPolicyFieldsProps {
  policy: GitHubCliPolicy;
  onChange: (policy: GitHubCliPolicy) => void;
  disabled?: boolean;
}

/** The "Platform Policy" section's GitHub CLI inherit/custom controls, extracted from `ProfileFormDialog` to keep it under the file-size ceiling. */
export function GitHubCliPolicyFields({ policy, onChange, disabled }: GitHubCliPolicyFieldsProps) {
  function updatePermission(
    key: keyof GitHubCliPolicy['permissions'],
    value: GitHubCliPermissionLevel
  ) {
    onChange({ ...policy, permissions: { ...policy.permissions, [key]: value } });
  }

  return (
    <div className="grid gap-3">
      <SelectField
        label="GitHub CLI access"
        value={policy.mode}
        onChange={(mode) =>
          onChange({ ...policy, mode: mode as GitHubCliPolicy['mode'], repositoryScope: 'project' })
        }
        options={[
          { value: 'inherit', label: 'Inherit GitHub App installation permissions' },
          { value: 'custom', label: 'Restrict token minted for this profile' },
        ]}
        disabled={disabled}
      />

      {policy.mode === 'custom' && (
        <fieldset className="grid gap-2 rounded-md border border-border-default p-3">
          <legend className="px-1 text-sm font-medium text-fg-primary">
            Project repository token permissions
          </legend>
          <p className="m-0 text-xs text-fg-muted">
            These permissions apply to the project&rsquo;s selected repository set &mdash; the
            primary repository plus any additional repositories added under Repository Access
            &mdash; not only the primary repo. The token is narrowed to that set before each mint.
            Code contents must stay readable so the workspace can clone and fetch the
            repositories.
          </p>
          {GITHUB_PERMISSION_ROWS.map((row) => (
            <label
              key={row.key}
              className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
            >
              <span className="text-sm text-fg-primary">{row.label}</span>
              <select
                value={policy.permissions[row.key]}
                onChange={(e) =>
                  updatePermission(row.key, e.target.value as GitHubCliPermissionLevel)
                }
                disabled={disabled}
                className={SELECT_CLASSES}
              >
                {row.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
