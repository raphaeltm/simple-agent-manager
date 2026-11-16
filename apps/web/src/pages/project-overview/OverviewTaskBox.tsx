/**
 * The Overview's task box: the project chat's own new-chat composer (`ChatInput`) and start
 * path (`useNewChatComposer`), pinned under the page. Sending does not navigate: the box clears,
 * a one-line receipt says what started with a link to its chat, and the page shows the task in
 * Running now. A start that fails shows its error in the same line.
 */
import type { OverviewRunningChat } from '@simple-agent-manager/shared';
import { AlertTriangle, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { ProfileUsage } from '../../components/project-chat/profile-picker';
import { useAvailableCommands } from '../../hooks/useAvailableCommands';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useQueryScope } from '../../hooks/useQueryScope';
import { ChatInput } from '../project-chat/ChatInput';
import type { NewChatComposer } from '../project-chat/useNewChatComposer';

const RECEIPT_TITLE_MAX = 80;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long "Started: …" stays. The new row in Running now says the same thing for good, so the
 * line is only the moment's confirmation; typing the next task clears it sooner.
 */
export const DEFAULT_OVERVIEW_RECEIPT_MS = 8_000;
export const OVERVIEW_RECEIPT_MS = positiveInt(
  import.meta.env.VITE_OVERVIEW_RECEIPT_MS,
  DEFAULT_OVERVIEW_RECEIPT_MS
);

/** The task's first line, as the receipt names it until the chat gets its own topic. */
export function startedTitle(message: string): string {
  const line = message.trim().split('\n')[0]?.trim() ?? '';
  return line.length > RECEIPT_TITLE_MAX ? `${line.slice(0, RECEIPT_TITLE_MAX - 1)}…` : line;
}

interface StartedReceipt {
  title: string;
  sessionId: string;
}

/**
 * The receipt line. Both live regions are always in the DOM and empty when idle, so assistive
 * technology announces what appears in them; a failure is an alert, a start is a status.
 */
function ReceiptLine({
  projectId,
  started,
  error,
}: {
  projectId: string;
  started: StartedReceipt | null;
  error: string | null;
}) {
  return (
    <>
      <div role="alert">
        {error && (
          <p
            data-testid="overview-start-receipt"
            className="m-0 mb-2 flex min-w-0 items-center gap-1.5 text-[13px] text-danger-fg"
          >
            <AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 break-words">Couldn’t start: {error}</span>
          </p>
        )}
      </div>
      <div role="status" aria-live="polite">
        {!error && started && (
          <p
            data-testid="overview-start-receipt"
            className="m-0 mb-1 flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--sam-status-success-fg)]"
          >
            <Check size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 truncate">Started: {started.title}</span>
            <span aria-hidden="true">·</span>
            <Link
              to={`/projects/${projectId}/chat/${started.sessionId}`}
              className="-my-3 inline-flex min-h-11 shrink-0 items-center text-[13px] text-accent no-underline hover:underline"
            >
              Open chat
            </Link>
          </p>
        )}
      </div>
    </>
  );
}

export function OverviewTaskBox({
  composer,
  profileUsages,
  onStarted,
}: {
  composer: NewChatComposer;
  profileUsages: ReadonlyMap<string, ProfileUsage> | null;
  onStarted: (chat: OverviewRunningChat) => void;
}) {
  const isMobile = useIsMobile();
  const queryScope = useQueryScope();
  const { projectId, profileChoice, attachments, overrides } = composer;
  const { commands: slashCommands } = useAvailableCommands(projectId);
  const [started, setStarted] = useState<StartedReceipt | null>(null);
  // The confirmation is momentary: it leaves after a while, or as soon as the next task is typed.
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(null), OVERVIEW_RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [started]);
  const typing = composer.message.length > 0;
  useEffect(() => {
    if (typing) setStarted(null);
  }, [typing]);

  const handleSubmit = async () => {
    const start = await composer.startNewChat(null);
    if (!start) {
      // The failure is in `composer.submitError`; an earlier receipt no longer describes the box.
      setStarted(null);
      return;
    }
    const title = startedTitle(start.message);
    const profile = composer.agentProfiles.find((p) => p.id === start.profileId) ?? null;
    const now = Date.now();
    setStarted({ title, sessionId: start.sessionId });
    onStarted({
      sessionId: start.sessionId,
      taskId: start.kind === 'task' ? start.taskId : null,
      topic: title,
      state: 'starting',
      waitingOnViewer: false,
      startedAt: now,
      lastActivityAt: now,
      profile: profile ? { id: profile.id, name: profile.name } : null,
      createdByUserId: queryScope || null,
    });
  };

  return (
    <ChatInput
      value={composer.message}
      onChange={composer.setMessage}
      onSubmit={() => void handleSubmit()}
      submitting={composer.submitting}
      error={null}
      receipt={<ReceiptLine projectId={projectId} started={started} error={composer.submitError} />}
      placeholder="Start a task…"
      transcribeApiUrl={composer.transcribeApiUrl}
      projectId={projectId}
      agents={composer.configuredAgents}
      agentProfiles={composer.agentProfiles}
      profilesLoading={profileChoice.profilesLoading}
      selectedProfileId={composer.selectedProfileId}
      onProfileChange={profileChoice.setSelectedProfileId}
      profilePicker={profileChoice.profilePicker}
      profileUsages={profileUsages}
      profileSheet={profileChoice.profileSheet}
      onOpenProfileSheet={profileChoice.openProfileSheet}
      onCloseProfileSheet={profileChoice.closeProfileSheet}
      skills={composer.skills}
      selectedSkillId={composer.selectedSkillId}
      onSkillChange={composer.setSelectedSkillId}
      onUpdateProfile={profileChoice.handleUpdateProfile}
      taskResourceReqs={overrides.taskResourceReqs}
      onTaskResourceReqsChange={overrides.setTaskResourceReqs}
      taskResourceErrors={overrides.taskResourceErrors}
      onTaskResourceErrorsClear={() => overrides.setTaskResourceErrors({})}
      agentOverrides={overrides.agentOverrides}
      onAgentOverridesChange={overrides.setAgentOverrides}
      profileWizard={profileChoice.profileWizard}
      onOpenProfileWizard={profileChoice.openProfileWizard}
      onCloseProfileWizard={profileChoice.closeProfileWizard}
      onUpdateProfileWizard={profileChoice.updateProfileWizard}
      onCreateProfileFromWizard={profileChoice.createProfileFromWizard}
      suggestProfileName={profileChoice.suggestProfileName}
      slashCommands={slashCommands}
      attachments={attachments.chatAttachments}
      onFilesSelected={attachments.handleChatFilesSelected}
      onRemoveAttachment={attachments.handleRemoveChatAttachment}
      fileInputRef={attachments.chatFileInputRef}
      uploading={attachments.chatUploading}
      collapseToolbarWhenIdle={isMobile}
      focusOnMount={false}
      inputLabel="Start a task"
    />
  );
}
