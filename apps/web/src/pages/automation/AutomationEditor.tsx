/**
 * Routes into the create/edit flow:
 * - `automation/new` (`?start=`, `?template=`, `?sessionId=` to message that chat)
 * - `automation/trigger/:id/edit` and `automation/watch/:id/edit`
 * One-time automations change only their time, which their own page does.
 */
import type {
  ProjectStandingWatch,
  TriggerResponse,
  WebhookCredential,
} from '@simple-agent-manager/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';

import { useAuth } from '../../components/AuthProvider';
import { WebhookCredentialDialog } from '../../components/triggers/WebhookCredentialDialog';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { createTrigger, updateTrigger } from '../../lib/api';
import { automationPaths, isAutomationKind, isAutomationStart } from '../../lib/automation-routes';
import {
  createSchedule,
  createStandingWatch,
  updateStandingWatch,
} from '../../lib/project-events-api';
import { triggerDetailQueryOptions, watchDetailQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { useAutomationAccess, useAutomationLookups, useInvalidateAutomation } from './data';
import { DetailUnavailable } from './detail-parts';
import { EditorFlow } from './editor/EditorFlow';
import {
  friendlySaveError,
  scheduleCreateRequest,
  type StepId,
  triggerCreateRequest,
  triggerUpdateRequest,
  watchCreateRequest,
  watchUpdateRequest,
} from './editor/requests';
import {
  type EditorState,
  editorStateFromTrigger,
  editorStateFromWatch,
  newEditorState,
} from './editor/state';
import { templateById } from './editor/templates';
import { Loading, Notice, Page, PageHeader } from './page';

type Saved = { kind: 'trigger' | 'schedule' | 'watch'; id: string; credential?: WebhookCredential };

/** Saving, then the one-time webhook credential (if any), then the new automation's page. */
function useSave(save: (state: EditorState) => Promise<Saved>, successMessage: string) {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateAutomation();
  const [credential, setCredential] = useState<{ value: WebhookCredential; to: string } | null>(
    null
  );
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const mutation = useMutation({
    mutationFn: save,
    onMutate: () => setError(null),
    onSuccess: async (saved) => {
      toast.success(successMessage);
      await invalidate();
      const to = automationPaths.detail(projectId, saved.kind, saved.id);
      if (saved.credential) setCredential({ value: saved.credential, to });
      else navigate(to, { replace: true });
    },
    onError: (cause) => setError(friendlySaveError(cause)),
  });
  const dialog = credential ? (
    <WebhookCredentialDialog
      credential={credential.value}
      onClose={() => navigate(credential.to, { replace: true })}
    />
  ) : null;
  return { mutation, error, dialog };
}

const CREATE_STEPS: StepId[] = ['start', 'when', 'what', 'review'];

function CreateAutomation() {
  const { projectId } = useProjectContext();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const lookups = useAutomationLookups(projectId);
  const [initial] = useState(() => {
    const start = params.get('start');
    const sessionId = params.get('sessionId');
    const base = newEditorState({ start: isAutomationStart(start) ? start : null, sessionId });
    return templateById(params.get('template'))?.apply(base) ?? base;
  });
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const { mutation, error, dialog } = useSave(async (state) => {
    if (state.start === 'once') {
      const result = await createSchedule(projectId, scheduleCreateRequest(state, idempotencyKey));
      return { kind: 'schedule', id: result.schedule.id };
    }
    if (state.start === 'event') {
      const result = await createStandingWatch(
        projectId,
        watchCreateRequest(state, idempotencyKey)
      );
      return { kind: 'watch', id: result.watch.id };
    }
    const created = await createTrigger(projectId, triggerCreateRequest(state));
    return { kind: 'trigger', id: created.id, credential: created.webhookCredential };
  }, 'Created');
  return (
    <>
      <EditorFlow
        initial={initial}
        steps={CREATE_STEPS}
        // A template or a chat already chose what starts it; that step stays one Back away.
        firstStep={initial.start ? 'when' : 'start'}
        title="New automation"
        submitLabel="Create automation"
        closeTo={automationPaths.overview(projectId)}
        lookups={lookups}
        saving={mutation.isPending}
        saveError={error}
        onSave={(state) => mutation.mutate(state)}
        viewerEmail={user?.email ?? null}
      />
      {dialog}
    </>
  );
}

function EditTrigger({ trigger }: { trigger: TriggerResponse }) {
  const { projectId } = useProjectContext();
  const lookups = useAutomationLookups(projectId);
  const [initial] = useState(() => editorStateFromTrigger(trigger));
  const steps: StepId[] =
    trigger.sourceType === 'incident' ? ['what', 'review'] : ['when', 'what', 'review'];
  const { mutation, error, dialog } = useSave(async (state) => {
    const updated = await updateTrigger(
      projectId,
      trigger.id,
      triggerUpdateRequest(state, trigger)
    );
    return { kind: 'trigger', id: updated.id };
  }, 'Saved');
  return (
    <>
      <EditorFlow
        initial={initial}
        steps={steps}
        title={`Edit “${trigger.name}”`}
        submitLabel="Save changes"
        closeTo={automationPaths.detail(projectId, 'trigger', trigger.id)}
        lookups={lookups}
        saving={mutation.isPending}
        saveError={error}
        onSave={(state) => mutation.mutate(state)}
      />
      {dialog}
    </>
  );
}

function EditWatch({ watch }: { watch: ProjectStandingWatch }) {
  const { projectId } = useProjectContext();
  const lookups = useAutomationLookups(projectId);
  const access = useAutomationAccess();
  const [initial] = useState(() => editorStateFromWatch(watch));
  const isCreator = watch.creatorUserId === access.userId;
  const { mutation, error, dialog } = useSave(async (state) => {
    const result = await updateStandingWatch(
      projectId,
      watch.id,
      watchUpdateRequest(state, watch, isCreator)
    );
    return { kind: 'watch', id: result.watch.id };
  }, 'Saved');
  return (
    <>
      <EditorFlow
        initial={initial}
        steps={['when', 'what', 'review']}
        title={`Edit “${watch.reason?.trim() || 'watch'}”`}
        submitLabel="Save changes"
        closeTo={automationPaths.detail(projectId, 'watch', watch.id)}
        lookups={lookups}
        lockedNote={
          isCreator
            ? undefined
            : `Only ${access.personName(watch.creatorUserId)} can change what this watch does, because it acts as them. You can still change what it waits for, its limits and its name.`
        }
        saving={mutation.isPending}
        saveError={error}
        onSave={(state) => mutation.mutate(state)}
      />
      {dialog}
    </>
  );
}

function ReadOnly() {
  const { projectId } = useProjectContext();
  return (
    <Page>
      <PageHeader
        back={{ label: 'Automation', to: automationPaths.overview(projectId) }}
        title="Automation"
      />
      <Notice>Only people who can edit this project can create or change automation.</Notice>
    </Page>
  );
}

export function AutomationEditor() {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const access = useAutomationAccess();
  // Not `id`: the project route above already owns that name.
  const { kind, automationId: id } = useParams<{ kind?: string; automationId?: string }>();
  const editing = Boolean(id && isAutomationKind(kind));
  const trigger = useQuery({
    ...triggerDetailQueryOptions(queryScope, projectId, id ?? ''),
    enabled: Boolean(queryScope && id && kind === 'trigger'),
  });
  const watch = useQuery({
    ...watchDetailQueryOptions(queryScope, projectId, id ?? ''),
    enabled: Boolean(queryScope && id && kind === 'watch'),
  });

  if (!access.canWrite) return access.checking ? <Loading /> : <ReadOnly />;
  if (!editing)
    return id ? (
      <Navigate to={automationPaths.overview(projectId)} replace />
    ) : (
      <CreateAutomation />
    );
  if (kind === 'schedule' && id)
    return <Navigate to={automationPaths.detail(projectId, 'schedule', id)} replace />;
  if (kind === 'trigger') {
    if (trigger.data) return <EditTrigger key={trigger.data.id} trigger={trigger.data} />;
    return trigger.isPending ? (
      <Loading />
    ) : (
      <DetailUnavailable what="automation" error={trigger.error} />
    );
  }
  if (watch.data) return <EditWatch key={watch.data.id} watch={watch.data} />;
  return watch.isPending ? <Loading /> : <DetailUnavailable what="watch" error={watch.error} />;
}
