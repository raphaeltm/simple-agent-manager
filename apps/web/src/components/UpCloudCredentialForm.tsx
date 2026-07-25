import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useStructuredCredentialForm } from '../hooks/useStructuredCredentialForm';

interface UpCloudCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/** Form for adding/updating/deleting UpCloud credentials (username + password). */
export function UpCloudCredentialForm({ credential, onUpdate }: UpCloudCredentialFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const form = useStructuredCredentialForm({
    provider: 'upcloud',
    title: 'UpCloud',
    hasCredential: Boolean(credential),
    onUpdate,
  });

  const updateField = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    form.clearMessages();
  };

  if (credential && !form.showForm) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between p-4 bg-success-tint border border-success/30 rounded-md">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-success-tint rounded-full flex items-center justify-center">
              <svg
                className="h-5 w-5 text-success-fg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-success-fg">Connected</p>
              <p className="text-sm text-fg-muted">
                Added: {new Date(credential.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => form.setShowForm(true)}
              aria-label="Update UpCloud credentials"
              className="py-1 px-3 text-sm bg-transparent border-none cursor-pointer text-accent"
            >
              Update
            </button>
            <button
              onClick={form.remove}
              disabled={form.loading}
              aria-label="Disconnect UpCloud account"
              className={`py-1 px-3 text-sm bg-transparent border-none cursor-pointer text-danger ${form.loading ? 'opacity-50' : 'opacity-100'}`}
            >
              {form.loading ? 'Removing...' : 'Disconnect'}
            </button>
          </div>
        </div>
        {form.error && <Alert variant="error">{form.error}</Alert>}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.save({ provider: 'upcloud', username, password }, () => {
          setUsername('');
          setPassword('');
        });
      }}
      className="flex flex-col gap-4"
    >
      <div>
        <label
          htmlFor="upcloud-username"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          API Username
        </label>
        <Input
          id="upcloud-username"
          type="text"
          value={username}
          onChange={(event) => updateField(setUsername)(event.target.value)}
          placeholder="Enter your UpCloud API username"
          required
        />
      </div>
      <div>
        <label
          htmlFor="upcloud-password"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          Password
        </label>
        <Input
          id="upcloud-password"
          type="password"
          value={password}
          onChange={(event) => updateField(setPassword)(event.target.value)}
          placeholder="Enter your UpCloud password"
          required
        />
        <p className="mt-1 text-xs text-fg-muted">
          Find your credentials in the{' '}
          <a
            href="https://hub.upcloud.com/people/accounts"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            UpCloud Hub
          </a>
          &gt; People &gt; Accounts
        </p>
      </div>
      {form.validationMessage && <Alert variant="success">{form.validationMessage}</Alert>}
      {form.error && <Alert variant="error">{form.error}</Alert>}
      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={form.loading || !username || !password}
          loading={form.loading}
        >
          {form.submitLabel}
        </Button>
        {form.showForm && (
          <Button type="button" variant="secondary" onClick={() => form.setShowForm(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
