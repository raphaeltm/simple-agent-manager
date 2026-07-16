import type { MentionPaletteHandle, SlashCommand, SlashCommandPaletteHandle } from '@simple-agent-manager/acp-client';
import { MentionPalette, SlashCommandPalette, VoiceButton } from '@simple-agent-manager/acp-client';
import type { AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { Paperclip, X } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatFileSize } from '../../lib/file-utils';
import { getSendButtonTitle, getSendShortcutAriaKey, getSendShortcutHint } from '../../lib/platform-shortcuts';
import { SkillSelector } from '../skills/SkillSelector';

export interface ProjectChatComposerAttachment {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

interface ProjectChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder: string;
  transcribeApiUrl: string;
  slashCommands?: SlashCommand[];
  agentProfiles?: AgentProfile[];
  skills?: AgentSkill[];
  selectedSkillId?: string | null;
  onSkillChange?: (skillId: string | null) => void;
  attachments?: ProjectChatComposerAttachment[];
  onFilesSelected?: (files: FileList | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: MutableRefObject<HTMLInputElement | null>;
  uploading?: boolean;
  showShortcutHint?: boolean;
  attachTitle?: string;
}

const TEXTAREA_MAX_HEIGHT_PX = 120;

function formatMentionName(name: string) {
  return name.includes(' ') ? `@"${name}" ` : `@${name} `;
}

export function ProjectChatComposer({
  value,
  onChange,
  onSend,
  sending,
  disabled = false,
  placeholder,
  transcribeApiUrl,
  slashCommands = [],
  agentProfiles = [],
  skills = [],
  selectedSkillId = null,
  onSkillChange,
  attachments = [],
  onFilesSelected,
  onRemoveAttachment,
  fileInputRef,
  uploading = false,
  showShortcutHint = true,
  attachTitle = 'Attach files',
}: ProjectChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const internalFileInputRef = useRef<HTMLInputElement | null>(null);
  const slashPaletteRef = useRef<SlashCommandPaletteHandle>(null);
  const mentionPaletteRef = useRef<MentionPaletteHandle>(null);
  const [cursorPos, setCursorPos] = useState(() => value.length);
  const dismissedSlashFilterRef = useRef<string | null>(null);
  const dismissedMentionFilterRef = useRef<string | null>(null);

  const slashMatch = value.match(/^\/(\S*)$/);
  const slashFilter = slashMatch?.[1] ?? '';
  if (!slashMatch && dismissedSlashFilterRef.current !== null) {
    dismissedSlashFilterRef.current = null;
  }
  const showSlashPalette =
    !!slashMatch &&
    slashCommands.length > 0 &&
    dismissedSlashFilterRef.current !== slashFilter;

  const textBeforeCursor = value.slice(0, cursorPos);
  const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
  const mentionFilter = mentionMatch?.[1] ?? '';
  const mentionTriggerIndex = mentionMatch?.index ?? -1;
  if (!mentionMatch && dismissedMentionFilterRef.current !== null) {
    dismissedMentionFilterRef.current = null;
  }
  const showMentionPalette =
    !!mentionMatch &&
    agentProfiles.length > 0 &&
    !showSlashPalette &&
    dismissedMentionFilterRef.current !== mentionFilter;
  const sendButtonTitle = getSendButtonTitle();
  const sendShortcutAriaKey = getSendShortcutAriaKey();
  const sendShortcutHint = getSendShortcutHint();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [value]);

  const setFileInput = useCallback((node: HTMLInputElement | null) => {
    internalFileInputRef.current = node;
    if (fileInputRef) {
      fileInputRef.current = node;
    }
  }, [fileInputRef]);

  const handleTranscription = useCallback((text: string) => {
    const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
    onChange(value + separator + text);
    textareaRef.current?.focus();
  }, [value, onChange]);

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    onChange(`/${command.name} `);
    textareaRef.current?.focus();
  }, [onChange]);

  const handleMentionSelect = useCallback(
    (profile: { name: string }) => {
      const mention = formatMentionName(profile.name);
      const before = value.slice(0, mentionTriggerIndex);
      const after = value.slice(cursorPos);
      const nextValue = before + mention + after;
      const nextCursorPos = before.length + mention.length;
      onChange(nextValue);
      setCursorPos(nextCursorPos);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [cursorPos, mentionTriggerIndex, onChange, value],
  );

  const handleFilesSelected = useCallback((files: FileList | null) => {
    onFilesSelected?.(files);
    if (internalFileInputRef.current) internalFileInputRef.current.value = '';
  }, [onFilesSelected]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashPaletteRef.current?.handleKeyDown(event)) return;
    if (mentionPaletteRef.current?.handleKeyDown(event)) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !sending && !disabled) {
      event.preventDefault();
      onSend();
    }
  }, [disabled, onSend, sending]);

  const sendDisabled = sending || disabled || !value.trim() || uploading;

  return (
    <>
      {slashCommands.length > 0 && (
        <SlashCommandPalette
          ref={slashPaletteRef}
          commands={slashCommands}
          filter={slashFilter}
          onSelect={handleCommandSelect}
          onDismiss={() => {
            dismissedSlashFilterRef.current = slashFilter;
            textareaRef.current?.focus();
          }}
          visible={showSlashPalette}
        />
      )}
      {agentProfiles.length > 0 && (
        <MentionPalette
          ref={mentionPaletteRef}
          profiles={agentProfiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            description: profile.description,
          }))}
          filter={mentionFilter}
          onSelect={handleMentionSelect}
          onDismiss={() => {
            dismissedMentionFilterRef.current = mentionFilter;
            textareaRef.current?.focus();
          }}
          visible={showMentionPalette}
        />
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((attachment, index) => (
            <div
              key={`${attachment.file.name}-${index}`}
              className="relative flex items-center gap-1.5 py-1 px-2 rounded-sm bg-page border border-border-default text-xs max-w-[220px] overflow-hidden"
            >
              <span className="truncate text-fg-primary" title={attachment.file.name}>
                {attachment.file.name}
              </span>
              <span className="text-fg-muted shrink-0">
                {attachment.status === 'uploading'
                  ? `${attachment.progress}%`
                  : formatFileSize(attachment.file.size)}
              </span>
              {attachment.status === 'error' && (
                <span className="text-danger shrink-0" title={attachment.error}>!</span>
              )}
              {onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(index)}
                  className="shrink-0 p-0.5 bg-transparent border-none text-fg-muted hover:text-fg-primary cursor-pointer"
                  aria-label={`Remove ${attachment.file.name}`}
                >
                  <X size={12} />
                </button>
              )}
              {attachment.status === 'uploading' && (
                <div
                  className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis rounded-full transition-all"
                  style={{ width: `${attachment.progress}%` }}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {skills.length > 0 && onSkillChange && (
        <div className="mb-2 max-w-md">
          <SkillSelector
            skills={skills}
            selectedSkillId={selectedSkillId}
            onChange={onSkillChange}
            disabled={sending || disabled}
            compact
          />
        </div>
      )}
      <div className="flex gap-2 items-end">
        {onFilesSelected && (
          <>
            <input
              ref={setFileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => handleFilesSelected(event.target.files)}
            />
            <button
              type="button"
              onClick={() => internalFileInputRef.current?.click()}
              disabled={sending || disabled || uploading}
              className="shrink-0 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center bg-transparent border border-[rgba(34,197,94,0.12)] rounded-md text-fg-muted hover:text-fg-primary hover:border-[rgba(34,197,94,0.25)] hover:shadow-[0_0_8px_rgba(22,163,74,0.1)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              aria-label={attachTitle}
              title={attachTitle}
            >
              <Paperclip size={18} className={uploading ? 'animate-pulse' : ''} />
            </button>
          </>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setCursorPos(event.target.selectionStart ?? 0);
          }}
          onSelect={(event) => setCursorPos(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={sending || disabled}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSlashPalette || showMentionPalette}
          aria-controls={showSlashPalette ? 'slash-palette-listbox' : showMentionPalette ? 'mention-palette-listbox' : undefined}
          aria-activedescendant={showSlashPalette ? slashPaletteRef.current?.activeDescendantId : showMentionPalette ? mentionPaletteRef.current?.activeDescendantId : undefined}
          className="flex-1 p-2 px-3 bg-[var(--sam-form-bg)] border border-[rgba(34,197,94,0.12)] rounded-md text-fg-primary text-base outline-none resize-none font-[inherit] leading-[1.5] min-h-[38px] max-h-[120px] overflow-y-auto focus:border-[rgba(34,197,94,0.35)] focus:shadow-[0_0_0_3px_rgba(34,197,94,0.08),0_0_20px_rgba(22,163,74,0.08)] transition-all"
        />
        <VoiceButton
          onTranscription={handleTranscription}
          disabled={sending || disabled}
          apiUrl={transcribeApiUrl}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sendDisabled}
          title={sendButtonTitle}
          aria-keyshortcuts={sendShortcutAriaKey}
          className={`px-3 py-2 min-h-[44px] border-none rounded-md text-base font-medium whitespace-nowrap transition-all ${
            sendDisabled
              ? 'bg-inset text-fg-muted cursor-default opacity-50'
              : 'bg-[linear-gradient(135deg,var(--sam-color-accent-primary),#22c55e)] text-white cursor-pointer shadow-[0_0_16px_rgba(22,163,74,0.3)] hover:shadow-[0_0_24px_rgba(22,163,74,0.4)] hover:scale-[1.03]'
          }`}
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>
      {showShortcutHint && (
        <div className="sam-type-caption text-fg-muted mt-1">
          {sendShortcutHint}
        </div>
      )}
    </>
  );
}
