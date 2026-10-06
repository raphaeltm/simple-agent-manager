import {
  MCP_CONNECTION_NAME_RULE,
  type McpConnection,
  type McpConnectionAuthType,
} from '@simple-agent-manager/shared';
import { Button, Input, Select } from '@simple-agent-manager/ui';
import { type FC, type FormEvent, useId, useState } from 'react';

import {
  emptyMcpServerForm,
  mcpServerFormFor,
  type McpServerFormState,
} from './mcp-server-form-state';
import { McpServerHeadersField } from './McpServerHeadersField';

interface McpServerFormProps {
  /** The server being edited, or null to add a new one. */
  connection: McpConnection | null;
  saving: boolean;
  onSubmit: (form: McpServerFormState) => void;
  onCancel: () => void;
}

/**
 * Add or edit one MCP server.
 *
 * Editing never shows a stored secret — the API does not return them — so the URL, the token
 * and each saved header value start blank and are only replaced when the user types a new one.
 */
export const McpServerForm: FC<McpServerFormProps> = ({
  connection,
  saving,
  onSubmit,
  onCancel,
}) => {
  const editing = connection !== null;
  const [form, setForm] = useState<McpServerFormState>(() =>
    connection ? mcpServerFormFor(connection) : emptyMcpServerForm()
  );
  const id = useId();

  // A bearer token must be typed unless one is already saved for this server.
  const tokenRequired = !(editing && connection.hasToken);
  const [submitLabel, savingLabel] = editing
    ? ['Save changes', 'Saving…']
    : ['Add server', 'Adding…'];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!saving) onSubmit(form);
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={editing ? `Edit ${connection.name}` : 'Add MCP server'}
      className="min-w-0 space-y-3 rounded-md border border-border-default p-3"
    >
      <div>
        <label htmlFor={`${id}-name`} className="block text-xs font-medium text-fg-muted">
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="zapier"
          autoCapitalize="none"
          required
          className="mt-1"
        />
        <p className="mt-1 text-xs text-fg-muted break-words">
          Agents see tools namespaced by this name — {MCP_CONNECTION_NAME_RULE}.
        </p>
      </div>

      <div>
        <label htmlFor={`${id}-url`} className="block text-xs font-medium text-fg-muted">
          MCP endpoint URL
        </label>
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          placeholder={
            editing ? 'Leave blank to keep the saved URL' : 'https://mcp.zapier.com/api/mcp/s/...'
          }
          required={!editing}
          className="mt-1"
        />
        <p className="mt-1 text-xs text-fg-muted break-words">
          {editing
            ? `Saved URL: ${connection.urlHost}/… — stored encrypted and never shown in full.`
            : 'Stored encrypted and never shown again — some providers put the credential in the URL itself.'}
        </p>
      </div>

      <div>
        <label htmlFor={`${id}-auth`} className="block text-xs font-medium text-fg-muted">
          Authentication
        </label>
        <Select
          id={`${id}-auth`}
          value={form.authType}
          onChange={(e) => setForm({ ...form, authType: e.target.value as McpConnectionAuthType })}
          className="mt-1"
        >
          <option value="bearer">Bearer token</option>
          <option value="none">None (credential in URL or headers)</option>
        </Select>
      </div>

      {form.authType === 'bearer' && (
        <div>
          <label htmlFor={`${id}-token`} className="block text-xs font-medium text-fg-muted">
            Bearer token
          </label>
          <Input
            id={`${id}-token`}
            type="password"
            autoComplete="off"
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
            placeholder={tokenRequired ? undefined : 'Leave blank to keep the saved token'}
            required={tokenRequired}
            className="mt-1"
          />
        </div>
      )}

      <McpServerHeadersField
        headers={form.headers}
        onChange={(headers) => setForm({ ...form, headers })}
      />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? savingLabel : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
};
