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
  onUploadFiles?: (files: FileList) => void;
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
          if (files && files.length > 0) onUploadFiles(files);
        } : undefined}
        showShortcutHint={!isMobile}
      />
    </div>
  );
}
