import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import type { ReactNode, Ref } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import {
  ProjectChatComposer,
  type ProjectChatComposerAttachment,
} from '../project-chat/ProjectChatComposer';

/** Follow-up message input for active, idle, or sleeping resumable sessions. */
export function FollowUpInput({
  value,
  onChange,
  onSend,
  onUploadFiles,
  sending,
  uploading,
  attachments,
  onRemoveAttachment,
  uploadError,
  placeholder,
  transcribeApiUrl,
  slashCommands,
  agentProfiles,
  deliveryControl,
  sendIcon,
  sendAddon,
  belowInput,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onUploadFiles?: (files: FileList | File[]) => void;
  sending: boolean;
  uploading?: boolean;
  attachments?: ProjectChatComposerAttachment[];
  onRemoveAttachment?: (index: number) => void;
  uploadError?: string | null;
  placeholder: string;
  transcribeApiUrl: string;
  slashCommands?: SlashCommand[];
  agentProfiles?: AgentProfile[];
  /** Steer/queue choice, shown above the composer while the agent works. */
  deliveryControl?: ReactNode;
  /** PROTOTYPE pass-throughs for the steering alternatives. */
  sendIcon?: ReactNode;
  sendAddon?: ReactNode;
  belowInput?: ReactNode;
}) {
  const isMobile = useIsMobile();

  return (
    <div className="relative shrink-0 px-3 py-3 md:px-4">
      {uploadError && (
        <p role="alert" className="text-danger text-sm">
          {uploadError}
        </p>
      )}
      {deliveryControl}
      <ProjectChatComposer
        value={value}
        onChange={onChange}
        onSend={onSend}
        sending={sending}
        uploading={uploading}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        placeholder={placeholder}
        transcribeApiUrl={transcribeApiUrl}
        slashCommands={slashCommands}
        agentProfiles={agentProfiles}
        onFilesSelected={
          onUploadFiles
            ? (files) => {
                if (files && files.length > 0) onUploadFiles(files);
              }
            : undefined
        }
        showShortcutHint={!isMobile && !belowInput}
        sendIcon={sendIcon}
        sendAddon={sendAddon}
        belowInput={belowInput}
      />
    </div>
  );
}

/**
 * Shown instead of the composer to someone who can't drive this chat. `ended` covers an
 * archived chat, which only its owner can fork and which can no longer be shared.
 * `accessEnded` is for a teammate whose shared access just ran out or was revoked, so the
 * footer says so instead of reading as if they never had it.
 */
export function ReadOnlyFollowUp({
  ownerLabel,
  onNewChat,
  ended = false,
  accessEnded = false,
  noticeRef,
}: {
  ownerLabel: string;
  onNewChat?: () => void;
  ended?: boolean;
  accessEnded?: boolean;
  /** Lets the chat move focus here when it closes a panel this viewer can no longer use. */
  noticeRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="relative shrink-0 px-3 py-3 md:px-4">
      <div
        ref={noticeRef}
        tabIndex={-1}
        className="sam-well flex items-center gap-3 rounded-[14px] px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg-primary break-words">
            {ended
              ? 'This chat has ended'
              : accessEnded
                ? 'Your shared access has ended'
                : `Only ${ownerLabel} can message this agent`}
          </div>
          <div className="text-xs text-fg-muted break-words">
            {ended
              ? `Only ${ownerLabel} can fork it to continue.`
              : accessEnded
                ? `You can still read and comment. Ask ${ownerLabel} to share it again to keep chatting.`
                : `You can leave comments on any message, or ask ${ownerLabel} to share this chat.`}
          </div>
        </div>
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="sam-raised min-h-10 shrink-0 cursor-pointer rounded-[var(--sam-radius-control)] border-0 px-3 text-xs font-medium text-[var(--sam-status-success-fg)] transition-[filter] hover:brightness-110"
          >
            Start your own chat
          </button>
        )}
      </div>
    </div>
  );
}
