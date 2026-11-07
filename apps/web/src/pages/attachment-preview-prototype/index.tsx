/**
 * /prototype/attachment-previews — composer attachment previews, three variants.
 *
 * Renders the REAL ProjectChatComposer (so pasting a long text or picking a file goes
 * through production's paste→File path) and swaps only the attachment row above it.
 * Query params make every state screenshot-addressable:
 *   ?variant=chips|tiles|cards&scenario=<ScenarioId>&open=<index>&theme=light|dark
 * PROTOTYPE ONLY — dev-only route, never ship.
 */
import { Pane, SegmentedControl } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ProjectChatComposer } from '../../components/project-chat/ProjectChatComposer';
import { useTheme } from '../../contexts/ThemeContext';
import { formatFileSize } from '../../lib/file-utils';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import { AttachmentStrip, type StripVariant } from './AttachmentStrips';
import { buildMockAttachments, type ProtoAttachment, type ScenarioId,SCENARIOS } from './mock-data';

const VARIANTS: { value: StripVariant; label: string }[] = [
  { value: 'chips', label: 'A · Chips' },
  { value: 'tiles', label: 'B · Tiles' },
  { value: 'cards', label: 'C · Cards' },
];

/** Simulated upload speed for files you add yourself (percent per tick). */
const SIMULATED_UPLOAD_STEP = 9;
const SIMULATED_UPLOAD_TICK_MS = 120;

function param<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.search).get(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function AttachmentPreviewPrototype() {
  const { setTheme } = useTheme();
  const [variant, setVariant] = useState<StripVariant>(() =>
    param('variant', ['chips', 'tiles', 'cards'] as const, 'tiles')
  );
  const [scenario, setScenario] = useState<ScenarioId>(() =>
    param('scenario', SCENARIOS.map((s) => s.id), 'typical')
  );
  const [mocks, setMocks] = useState<Record<ScenarioId, ProtoAttachment[]> | null>(null);
  const [attachments, setAttachments] = useState<ProtoAttachment[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get('theme');
    if (theme === 'light' || theme === 'dark') setTheme(theme);
  }, [setTheme]);

  useEffect(() => {
    void buildMockAttachments().then(setMocks);
  }, []);

  useEffect(() => {
    if (!mocks) return;
    const list = mocks[scenario];
    setAttachments(list);
    const raw = new URLSearchParams(window.location.search).get('open');
    const open = raw === null ? NaN : Number(raw);
    setOpenId(Number.isInteger(open) && list[open] ? list[open].id : null);
  }, [mocks, scenario]);

  // Fake upload progress for files added through the real composer.
  const uploading = attachments.some((a) => a.status === 'uploading' && a.id.startsWith('user-'));
  useEffect(() => {
    if (!uploading) return;
    const timer = window.setInterval(() => {
      setAttachments((prev) =>
        prev.map((a) => {
          if (!a.id.startsWith('user-') || a.status !== 'uploading') return a;
          const progress = Math.min(100, a.progress + SIMULATED_UPLOAD_STEP);
          return { ...a, progress, status: progress >= 100 ? 'complete' : 'uploading' };
        })
      );
    }, SIMULATED_UPLOAD_TICK_MS);
    return () => window.clearInterval(timer);
  }, [uploading]);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const added = Array.from(files).map<ProtoAttachment>((file) => ({
      id: `user-${seq.current++}`,
      file,
      progress: 0,
      status: 'uploading',
    }));
    setAttachments((prev) => [...prev, ...added]);
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const moveToMessage = useCallback((id: string, text: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setMessage((prev) => (prev ? `${prev}\n\n${text}` : text));
    setOpenId(null);
  }, []);

  const closePreview = useCallback(() => setOpenId(null), []);

  const totalBytes = useMemo(() => attachments.reduce((n, a) => n + a.file.size, 0), [attachments]);

  return (
    <div className="sam-void flex flex-col gap-2.5 p-2.5" style={{ height: '100dvh', overflow: 'hidden' }}>
      <Pane variant="pane" as="header" className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2.5">
        <h1 className="m-0 mr-auto text-sm font-semibold text-fg-primary">Attachment previews · prototype</h1>
        <SegmentedControl
          label="Variant"
          value={variant}
          onChange={setVariant}
          options={VARIANTS}
          className="w-full sm:w-[22rem]"
        />
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span className="sr-only sm:not-sr-only">Data</span>
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value as ScenarioId)}
            className="sam-well h-[30px] max-w-[11rem] rounded-[var(--sam-radius-control)] border-0 bg-[var(--sam-form-bg)] px-2 text-[13px] text-fg-primary"
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </Pane>

      {/* Stand-in transcript: the scroll lives here, not on <body> (app-shell convention). */}
      <Pane variant="pane" className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 text-sm">
          <div className="max-w-[85%] self-end rounded-[14px] bg-[var(--sam-form-bg)] px-3 py-2 text-fg-primary">
            Here’s the log from the failed deploy, and a screenshot of what I saw.
          </div>
          <div className="max-w-[85%] rounded-[14px] px-1 py-1 text-fg-primary">
            Got it — send them over and I’ll take a look. Tap any attachment above the message box to
            check it’s the right one before you send.
          </div>
          <p className="m-0 text-xs text-fg-muted">
            Try it: paste ≥4,000 characters into the box (becomes “Pasted text”), drop or attach your own
            files, then tap them. Switch variants and data sets in the header.
          </p>
        </div>
      </Pane>

      <Pane variant="slab" className="shrink-0" data-testid="composer-slab">
        <div className="relative px-3 py-3 md:px-4">
          {attachments.length > 3 && (
            <div className="mb-1.5 flex items-center gap-2 px-0.5 text-xs text-fg-muted">
              <span>
                {attachments.length} attachments · {formatFileSize(totalBytes)}
              </span>
              <button
                type="button"
                onClick={() => setAttachments([])}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-muted underline hover:text-fg-primary"
              >
                Remove all
              </button>
            </div>
          )}
          <AttachmentStrip
            variant={variant}
            attachments={attachments}
            onOpen={setOpenId}
            onRemove={remove}
          />
          <ProjectChatComposer
            value={message}
            onChange={setMessage}
            onSend={() => setMessage('')}
            sending={false}
            placeholder="Send a message to the agent..."
            transcribeApiUrl="/api/transcribe"
            onFilesSelected={addFiles}
            focusOnMount={false}
          />
        </div>
      </Pane>

      {openId && (
        <AttachmentPreviewDialog
          attachments={attachments}
          openId={openId}
          onClose={closePreview}
          onNavigate={setOpenId}
          onRemove={remove}
          onMoveToMessage={moveToMessage}
        />
      )}
    </div>
  );
}
