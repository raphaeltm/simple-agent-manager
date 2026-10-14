import type { AgentProfile } from '@simple-agent-manager/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import * as v from 'valibot';

import { ApiClientError } from '../../lib/api/client';
import { submitTask, type SubmitTaskRequest } from '../../lib/api/tasks';
import { getAuthEpoch, registerTerminalCleanup } from '../../lib/terminal-cleanup';
import { useAuth } from '../AuthProvider';
import { ProjectChatComposer } from '../project-chat/ProjectChatComposer';

const STORAGE_PREFIX = 'sam-archived-fork:';
// Use the existing auth-revocation cleanup registry for this tab's saved intent.
registerTerminalCleanup(() => {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
  }
});

const IntentSchema = v.object({
  key: v.string(),
  body: v.object({
    message: v.string(),
    sourceSessionId: v.string(),
    agentProfileId: v.optional(v.string()),
    taskMode: v.literal('conversation'),
  }),
  sessionId: v.optional(v.string()),
});

type Intent = v.InferOutput<typeof IntentSchema>;

function readIntent(storageKey: string): Intent | null {
  try {
    const result = v.safeParse(
      IntentSchema,
      JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
    );
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

/** One intent per source in this tab. A lost response/reload retries the exact
 * accepted request, never creates a second task under a replacement key. */
export function ArchivedForkComposer({
  projectId,
  sessionId,
  transcribeApiUrl,
  agentProfiles,
  workspaceExpired = false,
}: {
  projectId: string;
  sessionId: string;
  transcribeApiUrl: string;
  agentProfiles: AgentProfile[];
  workspaceExpired?: boolean;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const storageKey = `${STORAGE_PREFIX}${user?.id}:${projectId}:${sessionId}`;
  const [intent, setIntent] = useState(() => readIntent(storageKey));
  const [value, setValue] = useState(() => readIntent(storageKey)?.body.message ?? '');
  const [profileId, setProfileId] = useState(
    () => readIntent(storageKey)?.body.agentProfileId ?? ''
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = async () => {
    if (inFlight.current || !value.trim() || !user) return;
    if (intent?.sessionId) {
      navigate(`/projects/${projectId}/chat/${intent.sessionId}`);
      return;
    }
    const body: SubmitTaskRequest & { taskMode: 'conversation'; sourceSessionId: string } =
      intent?.body ?? {
        message: value,
        sourceSessionId: sessionId,
        taskMode: 'conversation',
        ...(profileId || agentProfiles[0]?.id
          ? { agentProfileId: profileId || agentProfiles[0]?.id }
          : {}),
      };
    const authEpoch = getAuthEpoch();
    // Canonicalize once before the first POST: persisted-schema parsing must
    // not change JSON key order and invalidate the receipt's exact-body hash.
    const nextIntent: Intent = intent ?? v.parse(IntentSchema, { key: crypto.randomUUID(), body });
    // Persist before network effects; if unavailable we cannot promise safe reload retry.
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(nextIntent));
    } catch {
      setError('Could not save this Fork request. Enable browser session storage and retry.');
      return;
    }
    setIntent(nextIntent);
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await submitTask(projectId, nextIntent.body, nextIntent.key);
      if (getAuthEpoch() !== authEpoch) return;
      const completed = { ...nextIntent, sessionId: result.sessionId };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(completed));
      } catch {
        /* Known success still navigates; the original keyed intent can replay on reload. */
      }
      if (mounted.current) {
        setIntent(completed);
        navigate(`/projects/${projectId}/chat/${result.sessionId}`);
      }
    } catch (err) {
      if (!mounted.current || getAuthEpoch() !== authEpoch) return;
      if (err instanceof ApiClientError && err.rejectedBeforeEffects) {
        sessionStorage.removeItem(storageKey);
        setIntent(null);
      }
      setError(
        err instanceof ApiClientError && err.code === 'OUTCOME_UNKNOWN'
          ? 'This Fork has an uncertain outcome. Check recent chats before starting new work. Retrying will not create a duplicate.'
          : err instanceof Error
            ? err.message
            : 'Could not fork this chat. Retry the saved request.'
      );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return (
    <div className="shrink-0 glass-chrome px-4 py-3 border-t border-border-default">
      <p className="sam-type-caption text-fg-muted mb-2 mt-0">
        {workspaceExpired &&
          'The saved workspace has expired. Your transcript is still available. '}
        Fork into a new chat with retained history. The archived chat stays unchanged. Prior
        workspace files are not restored.
      </p>
      {agentProfiles.length > 1 && (
        <label className="block text-sm mb-2">
          Agent{' '}
          <select
            aria-label="Fork agent"
            className="bg-surface border border-border-default rounded-md max-w-full"
            value={profileId || agentProfiles[0]?.id}
            disabled={sending || !!intent}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {agentProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="text-danger text-sm break-words">
          {error}{' '}
          {intent
            ? 'Your prompt is saved; Fork retries this same request.'
            : 'Fix the problem and retry.'}
        </p>
      )}
      {intent?.sessionId && (
        <p role="status" className="text-sm">
          Fork created. Open it with Fork below.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              sessionStorage.removeItem(storageKey);
              setIntent(null);
              setValue('');
              setError(null);
            }}
          >
            Start another fork
          </button>
        </p>
      )}
      <ProjectChatComposer
        value={value}
        onChange={(next) => {
          if (!intent) setValue(next);
        }}
        onSend={() => {
          void send();
        }}
        sending={sending}
        readOnly={!!intent}
        placeholder="Write a prompt to fork this archived chat..."
        transcribeApiUrl={transcribeApiUrl}
        focusOnMount={false}
        submitLabel="Fork"
        showShortcutHint={false}
      />
      {intent && (
        <p className="sam-type-caption text-fg-muted mb-0">
          Retry uses the saved prompt shown above.
        </p>
      )}
    </div>
  );
}
