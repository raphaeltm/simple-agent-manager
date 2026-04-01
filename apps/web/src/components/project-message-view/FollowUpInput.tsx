import { VoiceButton } from '@simple-agent-manager/acp-client';
import { Paperclip } from 'lucide-react';
import { useCallback, useRef } from 'react';

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
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onUploadFiles?: (files: FileList) => void;
  sending: boolean;
  uploading?: boolean;
  placeholder: string;
  transcribeApiUrl: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleTranscription = useCallback(
    (text: string) => {
      const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
      onChange(value + separator + text);
      inputRef.current?.focus();
    },
    [value, onChange],
  );

  return (
    <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface">
      <div className="flex gap-2 items-end">
        {onUploadFiles && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadFiles(e.target.files);
                  e.target.value = ''; // reset so same file can be re-uploaded
                }
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Attach files"
              className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
              style={{ opacity: uploading ? 0.5 : 1 }}
            >
              <Paperclip size={18} className={uploading ? 'animate-pulse' : ''} />
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !sending) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          disabled={sending}
          rows={1}
          className="flex-1 p-2 px-3 bg-page border border-border-default rounded-md text-fg-primary text-base outline-none resize-none font-[inherit] leading-[1.5] min-h-[38px] max-h-[120px]"
        />
        <VoiceButton
          onTranscription={handleTranscription}
          disabled={sending}
          apiUrl={transcribeApiUrl}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !value.trim()}
          className="px-3 py-2 border-none rounded-md text-base font-medium"
          style={{
            backgroundColor: sending || !value.trim() ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: sending || !value.trim() ? 'var(--sam-color-fg-muted)' : 'white',
            cursor: sending || !value.trim() ? 'default' : 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
