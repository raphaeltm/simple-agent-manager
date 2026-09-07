import type { ProjectScheduledAction } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { listAgentProfiles, listChatSessions, listSkills } from '../../lib/api';
import { EVENT_PAGE_SIZE } from '../../lib/project-events-api';
import { controlClass, Feedback, Field } from './EventUi';

export function initialAction(sessionId?: string): ProjectScheduledAction {
  return sessionId
    ? { kind: 'message_session', sessionId, prompt: '' }
    : { kind: 'start_session', prompt: '', agentProfileId: null, skillId: null };
}

export function EventActionFields({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: ProjectScheduledAction;
  onChange: (value: ProjectScheduledAction) => void;
}) {
  const scope = useQueryScope();
  const [offset, setOffset] = useState(0);
  const sessions = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'sessions', offset],
    queryFn: () => listChatSessions(projectId, { scope: 'all', limit: EVENT_PAGE_SIZE, offset }),
    enabled: Boolean(scope) && value.kind === 'message_session',
  });
  const profiles = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'profiles'],
    queryFn: () => listAgentProfiles(projectId),
    enabled: Boolean(scope) && value.kind === 'start_session',
  });
  const skills = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'skills'],
    queryFn: () => listSkills(projectId),
    enabled: Boolean(scope) && value.kind === 'start_session',
  });
  return (
    <div className="space-y-3">
      <Field label="Action">
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={value.kind}
            onChange={(event) =>
              onChange(
                event.target.value === 'message_session'
                  ? { kind: 'message_session', prompt: value.prompt, sessionId: '' }
                  : {
                      kind: 'start_session',
                      prompt: value.prompt,
                      agentProfileId: null,
                      skillId: null,
                    }
              )
            }
          >
            <option value="start_session">Start a new session</option>
            <option value="message_session">Message an existing session</option>
          </select>
        )}
      </Field>
      {value.kind === 'message_session' ? (
        <>
          <Field
            label="Target session"
            hint="Messages wait while a session is busy. A stopped or unavailable session can fail; check the resulting status."
          >
            {(id) => (
              <select
                id={id}
                required
                className={controlClass}
                value={value.sessionId}
                onChange={(event) => onChange({ ...value, sessionId: event.target.value })}
              >
                <option value="">
                  {sessions.isPending ? 'Loading sessions…' : 'Choose a session'}
                </option>
                {value.sessionId &&
                  !sessions.data?.sessions.some((s) => s.id === value.sessionId) && (
                    <option value={value.sessionId}>Selected session {value.sessionId}</option>
                  )}
                {sessions.data?.sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.topic || session.id} · {session.status}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Feedback error={sessions.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!offset || sessions.isFetching}
              onClick={() => setOffset(Math.max(0, offset - EVENT_PAGE_SIZE))}
            >
              Previous sessions
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={
                sessions.isFetching ||
                !sessions.data ||
                offset + EVENT_PAGE_SIZE >= sessions.data.total
              }
              onClick={() => setOffset(offset + EVENT_PAGE_SIZE)}
            >
              More sessions
            </Button>
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agent profile">
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={value.agentProfileId ?? ''}
                onChange={(event) =>
                  onChange({ ...value, agentProfileId: event.target.value || null })
                }
              >
                <option value="">Project default</option>
                {profiles.data?.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Skill">
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={value.skillId ?? ''}
                onChange={(event) => onChange({ ...value, skillId: event.target.value || null })}
              >
                <option value="">No additional skill</option>
                {skills.data?.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Feedback error={profiles.error || skills.error} />
        </div>
      )}
      <Field label="Prompt" hint="Describe the work to do when this action runs.">
        {(id) => (
          <textarea
            id={id}
            required
            rows={4}
            className={controlClass}
            value={value.prompt}
            onChange={(event) => onChange({ ...value, prompt: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}
