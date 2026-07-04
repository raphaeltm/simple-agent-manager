import type { ProjectInvitePreviewResponse } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { CheckCircle2, GitBranch, ShieldAlert, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { useToast } from '../hooks/useToast';
import {
  getProjectInvitePreview,
  requestProjectAccess,
} from '../lib/api';

function statusCopy(preview: ProjectInvitePreviewResponse): {
  body: string;
  title: string;
  tone: 'danger' | 'muted' | 'success';
} {
  if (preview.status === 'revoked') {
    return { title: 'Invite revoked', body: 'This invite link is no longer active.', tone: 'danger' };
  }
  if (preview.status === 'expired') {
    return { title: 'Invite expired', body: 'Ask a project member for a new link.', tone: 'danger' };
  }
  if (preview.membershipStatus === 'active-member') {
    return { title: 'Already a member', body: 'You already have access to this project.', tone: 'success' };
  }
  if (preview.membershipStatus === 'pending-request') {
    return { title: 'Request pending', body: 'An owner or admin can approve this request.', tone: 'muted' };
  }
  if (preview.membershipStatus === 'approved-request') {
    return { title: 'Access approved', body: 'You can open the project now.', tone: 'success' };
  }
  if (preview.membershipStatus === 'denied-request') {
    return { title: 'Request denied', body: 'You can request access again if this link is still active.', tone: 'danger' };
  }
  return { title: 'Request access', body: 'Your request will be reviewed by a project owner or admin.', tone: 'muted' };
}

export function ProjectInvite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [preview, setPreview] = useState<ProjectInvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setPreview(await getProjectInvitePreview(token));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load invite');
    } finally {
      setLoading(false);
    }
  }, [toast, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRequest = async () => {
    try {
      setRequesting(true);
      await requestProjectAccess(token);
      await load();
      toast.success('Access requested');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to request access');
    } finally {
      setRequesting(false);
    }
  };

  if (loading) {
    return (
      <div className="glass-surface rounded-lg p-4 flex items-center gap-2">
        <Spinner size="sm" />
        <span className="text-sm text-fg-muted">Loading invite&hellip;</span>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="glass-surface rounded-lg p-4">
        <h1 className="sam-type-section-heading m-0 text-fg-primary">Invite unavailable</h1>
      </div>
    );
  }

  const copy = statusCopy(preview);
  const canRequest =
    preview.status === 'active' &&
    (preview.membershipStatus === 'can-request' || preview.membershipStatus === 'denied-request');

  return (
    <div className="max-w-2xl mx-auto grid gap-4">
      <section className="glass-surface rounded-lg p-4 grid gap-4">
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 rounded-md p-2 ${
              copy.tone === 'danger'
                ? 'text-danger bg-[color-mix(in_srgb,var(--sam-color-danger)_12%,transparent)]'
                : copy.tone === 'success'
                  ? 'text-success bg-[color-mix(in_srgb,var(--sam-color-success)_12%,transparent)]'
                  : 'text-fg-muted bg-inset'
            }`}
          >
            {copy.tone === 'success' ? <CheckCircle2 size={18} /> : <UserPlus size={18} />}
          </div>
          <div className="min-w-0">
            <h1 className="m-0 text-lg font-semibold text-fg-primary">{copy.title}</h1>
            <p className="m-0 mt-1 text-sm text-fg-muted">{copy.body}</p>
          </div>
        </div>

        <div className="rounded-md border border-border-default bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_60%,transparent)] p-3 grid gap-2">
          <div className="text-[0.75rem] uppercase tracking-wide text-fg-muted">Project</div>
          <div className="text-base font-semibold text-fg-primary break-words">{preview.project.name}</div>
          <div className="flex items-center gap-2 text-[0.8125rem] text-fg-muted min-w-0">
            <GitBranch size={14} className="shrink-0" />
            <code className="truncate text-[0.8125rem]">{preview.project.repository}</code>
          </div>
        </div>

        {preview.accessRequest?.githubAccessMessage && (
          <div className="rounded-md border border-warning bg-[color-mix(in_srgb,var(--sam-color-warning)_10%,transparent)] p-3 flex gap-2">
            <ShieldAlert size={16} className="text-warning shrink-0 mt-0.5" />
            <p className="m-0 text-sm text-fg-primary">{preview.accessRequest.githubAccessMessage}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          {(preview.membershipStatus === 'active-member' ||
            preview.membershipStatus === 'approved-request') && (
            <Button size="sm" onClick={() => navigate(`/projects/${preview.project.id}`)}>
              Open Project
            </Button>
          )}
          {canRequest && (
            <Button
              size="sm"
              loading={requesting}
              disabled={requesting}
              onClick={() => void handleRequest()}
            >
              Request Access
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
