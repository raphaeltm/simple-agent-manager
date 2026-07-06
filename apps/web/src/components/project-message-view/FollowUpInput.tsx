import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';

import { useIsMobile } from '../../hooks/useIsMobile';
import { ProjectChatComposer } from '../project-chat/ProjectChatComposer';

/** Follow-up message input for active/idle sessions. */
export function FollowUpInput({
  value,
  onChange,
  onSend,
  onUploadFiles,
  sending,
  uploading,
  placeholder,
  transcribeApiUrl,
  slashCommands,
  agentProfiles,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onUploadFiles?: (files: File[] | FileList) => void;
  sending: boolean;
  uploading?: boolean;
  placeholder: string;
  transcribeApiUrl: string;
  slashCommands?: SlashCommand[];
  agentProfiles?: AgentProfile[];
}) {
  const isMobile = useIsMobile();

  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      <ProjectChatComposer
        value={value}
        onChange={onChange}
        onSend={onSend}
        sending={sending}
        uploading={uploading}
        placeholder={placeholder}
        transcribeApiUrl={transcribeApiUrl}
        slashCommands={slashCommands}
        agentProfiles={agentProfiles}
        onFilesSelected={onUploadFiles ? (files) => {
          if (!files) return;
          const arr = Array.from(files);
          if (arr.length > 0) onUploadFiles(arr);
        } : undefined}
        showShortcutHint={!isMobile}
      />
    </div>
  );
}

export function ReadOnlyFollowUp({
  ownerLabel,
  onNewChat,
}: {
  ownerLabel: string;
  onNewChat?: () => void;
}) {
  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 before:content-[''] before:absolute before:top-0 before:left-[15%] before:right-[15%] before:h-px before:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.18)_0%,transparent_70%)] before:pointer-events-none">
      <div className="flex items-center gap-3 rounded-md border border-border-default bg-surface/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg-primary">Read-only session</div>
          <div className="text-xs text-fg-muted truncate">
            Only {ownerLabel} can send messages here.
          </div>
        </div>
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 transition-colors"
          >
            New chat
          </button>
        )}
      </div>
    </div>
  );
}
