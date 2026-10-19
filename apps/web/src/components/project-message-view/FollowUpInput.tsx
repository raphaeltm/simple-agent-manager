import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';

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
}) {
  const isMobile = useIsMobile();

  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      {uploadError && (
        <p role="alert" className="text-danger text-sm">
          {uploadError}
        </p>
      )}
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
        showShortcutHint={!isMobile}
      />
    </div>
  );
}

/**
 * Shown instead of the composer to someone who can't drive this chat. `ended` covers an
 * archived chat, which only its owner can fork and which can no longer be shared.
 */
export function ReadOnlyFollowUp({
  ownerLabel,
  onNewChat,
  ended = false,
}: {
  ownerLabel: string;
  onNewChat?: () => void;
  ended?: boolean;
}) {
  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      <div className="flex items-center gap-3 rounded-md border border-border-default bg-surface/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg-primary break-words">
            {ended ? 'This chat has ended' : `Only ${ownerLabel} can message this agent`}
          </div>
          <div className="text-xs text-fg-muted break-words">
            {ended
              ? `Only ${ownerLabel} can fork it to continue.`
              : `You can leave comments on any message, or ask ${ownerLabel} to share this chat.`}
          </div>
        </div>
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 transition-colors"
          >
            Start your own chat
          </button>
        )}
      </div>
    </div>
  );
}
