import type {
  MentionPaletteHandle,
  SlashCommand,
  SlashCommandPaletteHandle,
} from '@simple-agent-manager/acp-client';
import {
  appendDictatedText,
  MentionPalette,
  SlashCommandPalette,
  VoiceButton,
} from '@simple-agent-manager/acp-client';
import type { AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { formatMentionName, getMentionQuery } from '@simple-agent-manager/shared';
import { ArrowRight, ArrowUp, Paperclip, X } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { formatFileSize } from '../../lib/file-utils';
import {
  getSendButtonTitle,
  getSendShortcutAriaKey,
  getSendShortcutHint,
} from '../../lib/platform-shortcuts';
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
  onFilesSelected?: (files: FileList | File[] | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: MutableRefObject<HTMLInputElement | null>;
  uploading?: boolean;
  showShortcutHint?: boolean;
  attachTitle?: string;
  /** False when the caller renders its own attach control (the new-chat toolbar). */
  showAttachButton?: boolean;
  submitLabel?: string;
  readOnly?: boolean;
  focusOnMount?: boolean;
}

const TEXTAREA_MAX_HEIGHT_PX = 120;
const DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD = 4000;
const configuredPasteThreshold = Number(import.meta.env.VITE_PASTED_TEXT_ATTACHMENT_THRESHOLD);
const PASTED_TEXT_ATTACHMENT_THRESHOLD =
  Number.isSafeInteger(configuredPasteThreshold) && configuredPasteThreshold > 0
    ? configuredPasteThreshold
    : DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD;

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
  showAttachButton = true,
  submitLabel = 'Send',
  readOnly = false,
  focusOnMount = true,
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
    !!slashMatch && slashCommands.length > 0 && dismissedSlashFilterRef.current !== slashFilter;

  const textBeforeCursor = value.slice(0, cursorPos);
  const mentionMatch = getMentionQuery(textBeforeCursor);
  const mentionFilter = mentionMatch?.filter ?? '';
  const mentionTriggerIndex = mentionMatch?.index ?? -1;
  if (!mentionMatch && dismissedMentionFilterRef.current !== null) {
    dismissedMentionFilterRef.current = null;
  }
  const showMentionPalette =
    !!mentionMatch &&
    agentProfiles.length > 0 &&
    !showSlashPalette &&
    dismissedMentionFilterRef.current !== mentionFilter;
  const sendButtonTitle = submitLabel === 'Send' ? getSendButtonTitle() : submitLabel;
  const sendShortcutAriaKey = getSendShortcutAriaKey();
  const sendShortcutHint = getSendShortcutHint();

  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [value]);

  const setFileInput = useCallback(
    (node: HTMLInputElement | null) => {
      internalFileInputRef.current = node;
      if (fileInputRef) {
        fileInputRef.current = node;
      }
    },
    [fileInputRef]
  );

  const handleTranscription = useCallback(
    (text: string) => {
      onChange(appendDictatedText(value, text));
      textareaRef.current?.focus();
    },
    [value, onChange]
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand) => {
      onChange(`/${command.name} `);
      textareaRef.current?.focus();
    },
    [onChange]
  );

  const handleMentionSelect = useCallback(
    (profile: { name: string }) => {
      const mention = `${formatMentionName(profile.name)} `;
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
    [cursorPos, mentionTriggerIndex, onChange, value]
  );

  const handleFilesSelected = useCallback(
    (files: FileList | File[] | null) => {
      onFilesSelected?.(files);
      if (internalFileInputRef.current) internalFileInputRef.current.value = '';
    },
    [onFilesSelected]
  );

  // Phones get the design's square arrow button; the label stays as its accessible name.
  const isMobile = useIsMobile();
  const iconOnlySend = isMobile && submitLabel === 'Send';
  const sendDisabled =
    sending ||
    disabled ||
    (!value.trim() && attachments.length === 0) ||
    uploading ||
    attachments.some((a) => a.status !== 'complete');

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashPaletteRef.current?.handleKeyDown(event)) return;
      if (mentionPaletteRef.current?.handleKeyDown(event)) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !sendDisabled) {
        event.preventDefault();
        onSend();
      }
    },
    [onSend, sendDisabled]
  );

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
        <div className="mb-2 flex max-h-[120px] overflow-y-auto flex-wrap gap-1.5">
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
                <span className="text-danger shrink-0" title={attachment.error}>
                  Failed
                </span>
              )}
              {onRemoveAttachment && (
                <button
                  type="button"
                  disabled={sending}
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
      <div
        className="flex gap-2 items-end"
        onDragOver={(event) => {
          if (onFilesSelected && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = sending || disabled ? 'none' : 'copy';
          }
        }}
        onDrop={(event) => {
          if (!onFilesSelected || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          if (!sending && !disabled) handleFilesSelected(event.dataTransfer.files);
        }}
      >
        {onFilesSelected && (
          <>
            <input
              ref={setFileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => handleFilesSelected(event.target.files)}
            />
            {showAttachButton && (
              <button
                type="button"
                onClick={() => internalFileInputRef.current?.click()}
                disabled={sending || disabled || uploading}
                className="sam-raised flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-[14px] border-0 text-fg-muted transition-colors hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                aria-label={attachTitle}
                title={attachTitle}
              >
                <Paperclip size={20} strokeWidth={1.75} className={uploading ? 'animate-pulse' : ''} />
              </button>
            )}
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
          onPaste={(event) => {
            if (!onFilesSelected || sending || disabled) return;
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              event.preventDefault();
              handleFilesSelected(files);
              return;
            }
            const text = event.clipboardData.getData('text/plain');
            if (text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD) {
              event.preventDefault();
              handleFilesSelected([
                new File([text], `pasted-${Date.now()}.txt`, { type: 'text/plain' }),
              ]);
            }
          }}
          placeholder={placeholder}
          disabled={sending || disabled}
          readOnly={readOnly}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSlashPalette || showMentionPalette}
          aria-controls={
            showSlashPalette
              ? 'slash-palette-listbox'
              : showMentionPalette
                ? 'mention-palette-listbox'
                : undefined
          }
          aria-activedescendant={
            showSlashPalette
              ? slashPaletteRef.current?.activeDescendantId
              : showMentionPalette
                ? mentionPaletteRef.current?.activeDescendantId
                : undefined
          }
          className="sam-well min-h-12 max-h-[160px] min-w-0 flex-1 resize-none overflow-y-auto rounded-[14px] border-0 bg-[var(--sam-form-bg)] px-4 py-3 font-[inherit] text-base leading-[1.5] text-fg-primary outline-none transition-shadow placeholder:text-fg-muted focus:shadow-[inset_0_1px_2px_var(--sam-glass-v2-well-shade),inset_0_0_0_1px_var(--sam-form-border-focus),0_0_0_3px_var(--sam-form-focus-ring)]"
        />
        <VoiceButton
          onTranscription={handleTranscription}
          disabled={sending || disabled || readOnly}
          apiUrl={transcribeApiUrl}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sendDisabled}
          title={sendButtonTitle}
          aria-keyshortcuts={sendShortcutAriaKey}
          aria-label={iconOnlySend ? (sending ? 'Sending...' : submitLabel) : undefined}
          className={`flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[14px] border-0 text-base font-semibold text-[var(--sam-on-accent)] transition-[filter,opacity] ${
            submitLabel === 'Fork' ? 'min-h-[56px]' : 'min-h-12'
          } ${iconOnlySend ? 'w-12' : 'px-5'} bg-[linear-gradient(180deg,var(--sam-accent-top),var(--sam-accent-bottom))] shadow-[inset_0_1px_0_rgb(255_255_255/0.32),inset_0_-1px_0_rgb(0_0_0/0.2),var(--sam-shadow-accent)] ${
            sendDisabled ? 'cursor-default opacity-45 shadow-none' : 'cursor-pointer hover:brightness-105'
          } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`}
        >
          {iconOnlySend ? (
            <ArrowUp size={22} strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <>
              {sending ? (submitLabel === 'Fork' ? 'Forking...' : 'Sending...') : submitLabel}
              {submitLabel === 'Send' && !sending && (
                <ArrowRight size={18} strokeWidth={2.25} aria-hidden="true" />
              )}
            </>
          )}
        </button>
      </div>
      {showShortcutHint && (
        <div className="mt-1.5 px-1 text-xs text-fg-muted">{sendShortcutHint}</div>
      )}
    </>
  );
}
