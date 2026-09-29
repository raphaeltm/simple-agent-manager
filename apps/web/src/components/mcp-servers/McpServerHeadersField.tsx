import { MCP_CONNECTION_HEADER_NAME_MAX_LENGTH } from '@simple-agent-manager/shared';
import { Button, Input } from '@simple-agent-manager/ui';
import { Plus, X } from 'lucide-react';
import type { FC } from 'react';

import { type McpHeaderRow, newHeaderRow } from './mcp-server-form-state';

interface McpServerHeadersFieldProps {
  headers: McpHeaderRow[];
  onChange: (headers: McpHeaderRow[]) => void;
}

/**
 * Custom HTTP headers for an MCP server, as name/value rows.
 *
 * A saved header shows its name as fixed text and a blank value that keeps the saved one:
 * the API never returns values, so there is nothing to prefill. Renaming a saved header is
 * remove-then-add, which keeps "blank means keep" unambiguous.
 *
 * Layout: on a phone each header is a bordered card whose value takes its own full-width line
 * beneath the name and the remove button, so it is clear which value belongs to which name;
 * from `sm` up the three share one borderless line. DOM order stays name, value, remove.
 */
export const McpServerHeadersField: FC<McpServerHeadersFieldProps> = ({ headers, onChange }) => {
  const update = (key: string, patch: Partial<McpHeaderRow>) =>
    onChange(headers.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="block text-xs font-medium text-fg-muted">Headers</legend>
      <p className="text-xs text-fg-muted break-words">
        Sent with every request, for example <code className="font-mono">x-api-key</code> for
        Composio. Values are stored encrypted and never shown again.
      </p>

      {headers.length > 0 && (
        <ul className="space-y-2">
          {headers.map((row, index) => {
            const label = row.name.trim() || `header ${index + 1}`;
            return (
              <li
                key={row.key}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border-default p-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:border-0 sm:p-0"
              >
                {row.stored ? (
                  <span className="col-start-1 row-start-1 min-w-0 break-all font-mono text-sm text-fg-primary">
                    {row.name}
                  </span>
                ) : (
                  <Input
                    aria-label={`Header ${index + 1} name`}
                    value={row.name}
                    onChange={(e) => update(row.key, { name: e.target.value })}
                    placeholder="x-api-key"
                    maxLength={MCP_CONNECTION_HEADER_NAME_MAX_LENGTH}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    className="col-start-1 row-start-1 font-mono"
                  />
                )}
                <Input
                  aria-label={`${label} value`}
                  type="password"
                  autoComplete="off"
                  value={row.value}
                  onChange={(e) => update(row.key, { value: e.target.value })}
                  placeholder={row.stored ? 'Leave blank to keep' : 'Value'}
                  required={!row.stored}
                  className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(headers.filter((candidate) => candidate.key !== row.key))}
                  className="col-start-2 row-start-1 sm:col-start-3"
                >
                  <X size={14} />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => onChange([...headers, newHeaderRow()])}
      >
        <Plus size={14} /> Add header
      </Button>
    </fieldset>
  );
};
