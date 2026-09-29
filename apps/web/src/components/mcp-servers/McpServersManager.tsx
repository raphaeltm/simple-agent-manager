import type { McpConnection } from '@simple-agent-manager/shared';
import { Alert, Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FC, useCallback, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { createMcpConnection, deleteMcpConnection, updateMcpConnection } from '../../lib/api';
import { mcpConnectionQueryKeys, mcpConnectionsQueryOptions } from '../../lib/query-options';
import { ConfirmDialog } from '../ConfirmDialog';
import { type McpServerFormState, toCreateRequest, toUpdateRequest } from './mcp-server-form-state';
import { McpServerForm } from './McpServerForm';

interface McpServersManagerProps {
  /** null = the caller's personal scope; a project id = that project's shared scope. */
  projectId: string | null;
  /** Identity namespace for the query key, so a cached list cannot cross accounts. */
  queryScope: string;
  /** False for members without `secret:write` — the list still renders, read-only. */
  canWrite?: boolean;
  /**
   * Section heading. Pass `null` when the host surface already provides one (the personal
   * settings page does), so the page does not render two identical headings.
   */
  title?: string | null;
}

/** At most one form is open: adding a server, or editing the one with this id. */
type Editor = { mode: 'create' } | { mode: 'edit'; connectionId: string } | null;

/**
 * One implementation for both the personal and project MCP-server scopes.
 *
 * The two scopes differ only in which endpoint they read and write, so they share this
 * component rather than growing a parallel copy (rules 24, 59).
 */
export const McpServersManager: FC<McpServersManagerProps> = ({
  projectId,
  queryScope,
  canWrite = true,
  title = 'MCP servers',
}) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpConnection | null>(null);

  const query = useQuery(mcpConnectionsQueryOptions(queryScope, projectId));
  const connections = query.data ?? [];

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all(queryScope) });
  }, [queryClient, queryScope]);

  const handleSubmit = async (form: McpServerFormState) => {
    if (!editor) return;
    const editing = editor.mode === 'edit';
    setSaving(true);
    try {
      if (editing) {
        await updateMcpConnection(projectId, editor.connectionId, toUpdateRequest(form));
      } else {
        await createMcpConnection(projectId, toCreateRequest(form));
      }
      await invalidate();
      setEditor(null);
      toast.success(editing ? 'MCP server updated' : 'MCP server added');
    } catch (error) {
      const fallback = editing ? 'Failed to update MCP server' : 'Failed to add MCP server';
      toast.error(error instanceof Error ? error.message : fallback);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (connection: McpConnection) => {
    setBusyId(connection.id);
    try {
      await updateMcpConnection(projectId, connection.id, { enabled: !connection.enabled });
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update MCP server');
    } finally {
      setBusyId(null);
    }
  };

  // Deliberately the app's ConfirmDialog rather than window.confirm: this is a destructive
  // action on a stored credential, and the shared dialog is the pattern the sibling settings
  // lists already use (ApiTokens, EnvironmentSecretsSection). It also traps and restores focus,
  // which the native dialog does not.
  const handleDelete = async () => {
    const connection = pendingDelete;
    if (!connection) return;
    setBusyId(connection.id);
    try {
      await deleteMcpConnection(projectId, connection.id);
      await invalidate();
      setPendingDelete(null);
      toast.success('MCP server removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove MCP server');
    } finally {
      setBusyId(null);
    }
  };

  // Gate rendering on "no data yet", never on "a refetch is in flight" (rule 48).
  if (query.isPending && query.data === undefined) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (query.data === undefined && query.error) {
    return (
      <Alert variant="error">
        <span className="break-words">
          Failed to load MCP servers
          {query.error instanceof Error && query.error.message ? `: ${query.error.message}` : '.'}
        </span>
      </Alert>
    );
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/*
            When the host supplies the heading (title={null}, the personal settings page) it
            also supplies the intro copy, so the scope line here would be a second, nearly
            identical paragraph above the list.
          */}
          {title !== null && (
            <>
              <h3 className="text-sm font-medium text-fg-primary">{title}</h3>
              <p className="mt-1 text-xs text-fg-muted break-words">
                {projectId === null
                  ? 'Available to every session you start, in any project.'
                  : 'Shared with everyone in this project. Connect a provider such as Zapier, executor.sh or Composio, then paste its MCP URL here.'}
              </p>
            </>
          )}
        </div>
        {canWrite && editor === null && (
          <Button size="sm" variant="secondary" onClick={() => setEditor({ mode: 'create' })}>
            <Plus size={14} /> Add
          </Button>
        )}
      </div>

      {editor?.mode === 'create' && canWrite && (
        <McpServerForm
          connection={null}
          saving={saving}
          onSubmit={(form) => void handleSubmit(form)}
          onCancel={() => setEditor(null)}
        />
      )}

      {connections.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No MCP servers yet. Agents in this scope get SAM&apos;s own tools only.
        </p>
      ) : (
        <ul className="space-y-2">
          {connections.map((connection) =>
            editor?.mode === 'edit' && editor.connectionId === connection.id && canWrite ? (
              <li key={connection.id}>
                <McpServerForm
                  connection={connection}
                  saving={saving}
                  onSubmit={(form) => void handleSubmit(form)}
                  onCancel={() => setEditor(null)}
                />
              </li>
            ) : (
              <li
                key={connection.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border-default p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg-primary break-words">
                      {connection.name}
                    </span>
                    {!connection.enabled && <StatusBadge status="disabled" pulse={false} />}
                  </div>
                  {/*
                    The host needs `break-all` because a pre-signed gateway subdomain has no
                    break opportunities, but the auth label must not inherit it — otherwise it
                    wraps as "bea rer token".
                  */}
                  <p className="mt-0.5 text-xs text-fg-muted">
                    <span className="break-all">{connection.urlHost}</span>
                    <span className="whitespace-nowrap">
                      {connection.hasToken ? ' · bearer token' : ' · no auth'}
                    </span>
                  </p>
                  {connection.headerNames.length > 0 && (
                    <p className="mt-0.5 text-xs text-fg-muted break-all">
                      Headers:{' '}
                      <span className="font-mono">{connection.headerNames.join(', ')}</span>
                    </p>
                  )}
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === connection.id}
                      onClick={() => void handleToggle(connection)}
                    >
                      {connection.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${connection.name}`}
                      disabled={editor !== null || busyId === connection.id}
                      onClick={() => setEditor({ mode: 'edit', connectionId: connection.id })}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${connection.name}`}
                      disabled={busyId === connection.id}
                      onClick={() => setPendingDelete(connection)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </li>
            )
          )}
        </ul>
      )}

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        title="Delete MCP server"
        message={
          pendingDelete ? (
            <>
              Agents will stop receiving tools from{' '}
              <strong className="text-fg-primary">{pendingDelete.name}</strong>. The stored
              credential is deleted and cannot be recovered.
            </>
          ) : null
        }
        confirmLabel="Delete"
        variant="danger"
        loading={busyId !== null && busyId === pendingDelete?.id}
      />
    </div>
  );
};
