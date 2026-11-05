import {
  type WorkloadIdentityMetadata,
  WorkloadIdentityMetadataSchema,
} from '@simple-agent-manager/shared';
import { ChevronDown, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as v from 'valibot';

import { request } from '../../lib/api/client';

function IdentityCopy({ label, value }: Readonly<{ label: string; value: string }>) {
  const [feedback, setFeedback] = useState('');
  return (
    <span className="inline-flex flex-wrap items-center gap-1 min-w-0">
      <button
        type="button"
        aria-label={`Copy ${label}`}
        // Raised secondary control (SAM Glass); the pseudo-element widens the tap target.
        className="sam-raised relative h-7 cursor-pointer rounded-full border-none px-2.5 text-[11px] font-medium text-fg-primary after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        onClick={() => {
          setFeedback('');
          void navigator.clipboard.writeText(value).then(
            () => setFeedback(`${label} copied`),
            () => setFeedback(`Could not copy ${label}. Select and copy the value manually.`)
          );
        }}
      >
        Copy
      </button>
      <output className="text-xs text-fg-muted">{feedback}</output>
    </span>
  );
}

/** Optional details load only when requested; never asks the server for a token. */
export function WorkloadIdentityDetails({
  projectId,
  sessionId,
}: Readonly<{
  projectId: string;
  sessionId: string;
}>) {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<WorkloadIdentityMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIdentity(null);
    setError(null);
    void request<unknown>(`/api/projects/${projectId}/sessions/${sessionId}/workload-identity`)
      .then((result) => {
        if (!cancelled) setIdentity(v.parse(WorkloadIdentityMetadataSchema, result));
      })
      .catch(() => {
        if (!cancelled)
          setError(
            'Identity details are unavailable. Reopen this section to retry. If this chat is asleep, wake it first.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, sessionId]);

  return (
    <details
      className="group min-w-0 border-t border-[var(--sam-hairline)] first:border-t-0"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {/* Styled like the other detail sections' labels, as a full-width 44px disclosure row. */}
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-[11px] font-semibold tracking-[0.1em] text-fg-muted uppercase hover:text-fg-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring md:px-6 [&::-webkit-details-marker]:hidden">
        <KeyRound size={12} aria-hidden="true" className="shrink-0" />
        <span className="flex-1">Workload identity (OIDC)</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="grid max-h-[60vh] min-w-0 gap-3 overflow-y-auto overscroll-contain px-4 pb-3 text-xs md:px-6">
        <p className="m-0 text-fg-muted">
          Use these IDs when configuring external services to trust this agent. Names can change;
          base access rules on IDs, issuer and audience.
        </p>
        {error && (
          <p role="alert" className="m-0 text-fg-muted">
            {error}
          </p>
        )}
        {!identity && !error && (
          <output className="m-0 text-fg-muted">Loading identity details…</output>
        )}
        {identity && (
          <>
            <dl className="grid gap-2 m-0 min-w-0">
              {Object.entries({
                Issuer: identity.issuer,
                Subject: identity.subject,
                'Public keys': identity.jwks_uri,
              }).map(([label, value]) => (
                <div key={label} className="grid gap-1 min-w-0">
                  <dt className="font-medium text-fg-muted">{label}</dt>
                  <dd className="m-0 min-w-0 flex flex-wrap items-center gap-2">
                    <span className="text-fg-primary [overflow-wrap:anywhere] min-w-0">
                      {value}
                    </span>
                    <IdentityCopy label={label} value={value} />
                  </dd>
                </div>
              ))}
            </dl>
            <dl className="grid gap-2 m-0 min-w-0">
              {Object.entries(identity.claims)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .map(([key, value]) => (
                  <div
                    key={key}
                    className="grid gap-1 min-w-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center"
                  >
                    <dt className="font-mono text-fg-muted break-words">{key}</dt>
                    <dd className="m-0 min-w-0 flex flex-wrap items-center gap-2">
                      <span className="text-fg-primary [overflow-wrap:anywhere] min-w-0">
                        {value}
                      </span>
                      {(key.endsWith('_id') ||
                        key === 'automation_type' ||
                        key === 'triggered_by') && (
                        <span className="shrink-0 max-w-full">
                          <IdentityCopy label={key} value={value} />
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
            <p className="m-0 text-fg-muted">
              Tokens last {identity.ttl_seconds} seconds. This preview does not create a token.
              Automation fields describe how the task started, not who wrote its latest message.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
