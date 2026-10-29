/**
 * Advanced settings → Attachments: one card per attachment, and the add form.
 */
import { Alert, Button, Select } from '@simple-agent-manager/ui';
import { useState } from 'react';

import {
  type CCAttachmentListItem,
  type CCConfigurationListItem,
  createCCAttachment,
} from '../../lib/api';

export interface ProjectOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Attachment CRUD
// ---------------------------------------------------------------------------

export function AttachmentCard({
  att,
  configurations,
  onToggle,
  onDelete,
}: {
  att: CCAttachmentListItem;
  configurations: CCConfigurationListItem[];
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const cfg = configurations.find((c) => c.id === att.configurationId);
  const label = cfg?.name ?? att.configurationId;
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-border-default p-3 ${
        att.isActive ? 'bg-surface' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm text-fg-primary">{label}</span>
        <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
          {att.projectId ? `project: ${att.projectId.slice(0, 8)}…` : 'user default'}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${att.isActive ? 'Deactivate' : 'Activate'} attachment ${label}`}
          onClick={onToggle}
        >
          {att.isActive ? 'Deactivate' : 'Activate'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          aria-label={`Delete attachment ${label}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

export function AddAttachmentForm({
  configurations,
  projects,
  onCreated,
}: {
  configurations: CCConfigurationListItem[];
  projects: ProjectOption[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [configurationId, setConfigurationId] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [projectId, setProjectId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configurationId) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await createCCAttachment({
        configurationId,
        projectId: scope === 'project' ? projectId : undefined,
      });
      setConfigurationId('');
      setScope('user');
      setProjectId('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create attachment');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + Add attachment
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface"
    >
      {formError && (
        <Alert variant="error" onDismiss={() => setFormError(null)}>
          {formError}
        </Alert>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-att-config" className="text-xs font-medium text-fg-muted">
          Configuration
        </label>
        <Select
          id="cc-att-config"
          value={configurationId}
          onChange={(e) => setConfigurationId(e.target.value)}
          required
        >
          <option value="">Select configuration</option>
          {configurations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-att-scope" className="text-xs font-medium text-fg-muted">
          Attachment target
        </label>
        <Select
          id="cc-att-scope"
          value={scope}
          onChange={(e) => {
            const nextScope = e.target.value === 'project' ? 'project' : 'user';
            setScope(nextScope);
            if (nextScope === 'user') setProjectId('');
          }}
        >
          <option value="user">User default</option>
          <option value="project">Project override</option>
        </Select>
      </div>
      {scope === 'project' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="cc-att-project" className="text-xs font-medium text-fg-muted">
            Project
          </label>
          <Select
            id="cc-att-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            <option value="">Select project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {scope === 'project' && projects.length === 0 && (
        <p className="m-0 text-xs text-fg-muted">
          No projects are available for project-scoped attachments.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={submitting}
          disabled={!configurationId || (scope === 'project' && !projectId)}
        >
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
