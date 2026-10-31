/**
 * Composable Credentials settings page — manages the three primitives:
 * Credentials, Configurations, and Attachments.
 */

import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { Alert, Card } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import {
  AddAttachmentForm,
  AttachmentCard,
  type ProjectOption,
} from '../components/settings-credentials/AttachmentParts';
import { ConfigurationSection } from '../components/settings-credentials/ConfigurationSection';
import {
  AddCredentialForm,
  CredentialCard,
} from '../components/settings-credentials/CredentialParts';
import { useInvalidateAccounts } from '../hooks/useAccounts';
import { useQueryScope } from '../hooks/useQueryScope';
import {
  type CCAttachmentListItem,
  type CCConfigurationListItem,
  type CCCredentialListItem,
  deleteCCAttachment,
  deleteCCCredential,
  listCCAttachments,
  listCCConfigurations,
  listCCCredentials,
  listProjects,
  updateCCAttachment,
  updateCCCredential,
} from '../lib/api';
import { myCredentialLimitsQueryOptions } from '../lib/query-options';

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SettingsCredentials() {
  const [credentials, setCredentials] = useState<CCCredentialListItem[]>([]);
  const [configurations, setConfigurations] = useState<CCConfigurationListItem[]>([]);
  const [attachments, setAttachments] = useState<CCAttachmentListItem[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queryScope = useQueryScope();
  const limitsQuery = useQuery({
    ...myCredentialLimitsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const usageByCredentialId = useMemo(() => {
    const map = new Map<string, CredentialLimitCredentialSummary>();
    for (const credential of limitsQuery.data?.credentials ?? []) {
      if (credential.credentialId) map.set(credential.credentialId, credential);
    }
    return map;
  }, [limitsQuery.data]);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [creds, cfgs, atts, projectData] = await Promise.all([
        listCCCredentials(),
        listCCConfigurations(),
        listCCAttachments(),
        listProjects(100),
      ]);
      setCredentials(creds);
      setConfigurations(cfgs);
      setAttachments(atts);
      setProjects(projectData.projects.map((project) => ({ id: project.id, name: project.name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Agents and Infrastructure read the same rows through the query cache.
  const invalidateAccounts = useInvalidateAccounts();
  const reloadAfterChange = useCallback(() => {
    loadAll();
    void invalidateAccounts();
  }, [loadAll, invalidateAccounts]);

  const handleMutation = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        reloadAfterChange();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Operation failed');
      }
    },
    [reloadAfterChange]
  );

  if (loading) {
    return (
      <p className="text-sm text-fg-muted p-4" role="status" aria-live="polite">
        Loading credentials…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert variant="info">
        This is the advanced view showing the raw composable-credentials primitives. Most people
        should manage accounts in{' '}
        <Link to="/settings/agents" className="text-accent font-medium">
          Agents
        </Link>{' '}
        and{' '}
        <Link to="/settings/infrastructure" className="text-accent font-medium">
          Infrastructure
        </Link>
        .
      </Alert>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Credentials */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-fg-primary">Credentials</h3>
            <p className="text-xs text-fg-muted">
              Named, typed secrets. Agent-agnostic — one key can power many configurations.
            </p>
          </div>
          {credentials.length === 0 && (
            <p className="text-xs text-fg-muted italic">No credentials yet</p>
          )}
          {credentials.map((cred) => (
            <CredentialCard
              key={cred.id}
              cred={cred}
              usage={usageByCredentialId.get(cred.id) ?? null}
              onToggle={() =>
                handleMutation(() => updateCCCredential(cred.id, { isActive: !cred.isActive }))
              }
              onDelete={() => {
                if (!confirm(`Delete credential "${cred.name}"? This cannot be undone.`))
                  return Promise.resolve();
                return handleMutation(() => deleteCCCredential(cred.id));
              }}
            />
          ))}
          <AddCredentialForm onCreated={reloadAfterChange} />
        </div>
      </Card>

      {/* Configurations */}
      <ConfigurationSection
        configurations={configurations}
        credentials={credentials}
        onMutation={handleMutation}
        onCreated={reloadAfterChange}
      />

      {/* Attachments */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-fg-primary">Attachments</h3>
            <p className="text-xs text-fg-muted">
              Bind configurations to scopes — user default or project override.
            </p>
          </div>
          {attachments.length === 0 && (
            <p className="text-xs text-fg-muted italic">No attachments yet</p>
          )}
          {attachments.map((att) => (
            <AttachmentCard
              key={att.id}
              att={att}
              configurations={configurations}
              onToggle={() =>
                handleMutation(() => updateCCAttachment(att.id, { isActive: !att.isActive }))
              }
              onDelete={() => {
                const cfg = configurations.find((c) => c.id === att.configurationId);
                const label = cfg?.name ?? att.configurationId;
                if (!confirm(`Delete attachment "${label}"? This cannot be undone.`))
                  return Promise.resolve();
                return handleMutation(() => deleteCCAttachment(att.id));
              }}
            />
          ))}
          <AddAttachmentForm
            configurations={configurations}
            projects={projects}
            onCreated={reloadAfterChange}
          />
        </div>
      </Card>
    </div>
  );
}
