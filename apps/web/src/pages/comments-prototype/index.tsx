import { Button } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Code2,
  FileText,
  Highlighter,
  Library,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Reply,
  Send,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  CHAT_MESSAGES,
  CHECKPOINT_NOTES,
  CODE_ANCHOR,
  CODE_CONTENT,
  EMPTY_COMMENTS,
  ERROR_MESSAGE,
  LIBRARY_ANCHORS,
  MANY_COMMENTS,
  MARKDOWN_CONTENT,
  MESSAGE_NOTES,
  PEOPLE,
  type ChatMessageMock,
  type CommentMock,
  type LibraryAnchorMock,
  type PrototypePerson,
} from './mock-data';

type Surface = 'chat' | 'library';
type Perspective = 'collaborator' | 'owner';
type LibraryFile = 'markdown' | 'code';
type FileView = 'rendered' | 'source';
type StressScenario = 'normal' | 'empty' | 'many' | 'error';

function initialParam<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  const value = new URLSearchParams(window.location.search).get(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function Avatar({ person, size = 'md' }: { person: PrototypePerson; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`${size === 'sm' ? 'h-6 w-6 text-[9px]' : 'h-8 w-8 text-[11px]'} inline-flex shrink-0 items-center justify-center rounded-full border border-white/10 font-semibold text-white shadow-sm`}
      style={{ backgroundColor: person.color }}
      aria-label={person.name}
      title={person.name}
    >
      {person.initials}
    </span>
  );
}

function IconButton({
  label,
  children,
  onClick,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring ${
        active
          ? 'border-[var(--sam-color-accent-primary)] bg-accent-primary-tint text-success-fg'
          : 'border-border-default bg-inset text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
      }`}
    >
      {children}
    </button>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      className="inline-flex min-w-0 items-center rounded-md border border-border-default bg-inset p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
            value === option.value
              ? 'bg-surface text-fg-primary shadow-sm'
              : 'text-fg-muted hover:text-fg-primary'
          }`}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function PrototypeChrome({
  surface,
  setSurface,
}: {
  surface: Surface;
  setSurface: (surface: Surface) => void;
}) {
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-default bg-[var(--sam-glass-bg-chrome)] px-3 backdrop-blur-xl md:px-5">
        <IconButton label="Back to projects">
          <ArrowLeft size={17} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg-primary">
              Simple Agent Manager
            </span>
            <span className="hidden rounded-full bg-status-success-bg px-2 py-0.5 text-[10px] font-semibold text-status-success-fg sm:inline">
              3 online
            </span>
          </div>
          <p className="m-0 truncate text-[11px] text-fg-muted">sam/comments-prototype</p>
        </div>
        <div className="flex -space-x-1.5" aria-label="Project members online">
          <Avatar person={PEOPLE.owner} size="sm" />
          <Avatar person={PEOPLE.maya} size="sm" />
          <Avatar person={PEOPLE.jordan} size="sm" />
        </div>
        <IconButton label="Project menu">
          <Menu size={17} />
        </IconButton>
      </header>
      <nav className="flex h-11 shrink-0 items-end gap-1 border-b border-border-default bg-[var(--sam-glass-bg-chrome)] px-3 md:px-5">
        {(
          [
            ['chat', 'Chat', MessageCircle],
            ['library', 'Library', Library],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            onClick={() => setSurface(value)}
            aria-current={surface === value ? 'page' : undefined}
            className={`relative flex h-10 items-center gap-2 px-3 text-sm font-medium transition-colors ${
              surface === value ? 'text-fg-primary' : 'text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Icon size={15} />
            {label}
            {surface === value && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
            )}
          </button>
        ))}
        <span className="mb-2 ml-auto rounded-full border border-border-default px-2 py-1 text-[10px] text-fg-muted">
          UX prototype
        </span>
      </nav>
    </>
  );
}

function PrototypeControls({
  perspective,
  setPerspective,
  scenario,
  setScenario,
  surface,
}: {
  perspective: Perspective;
  setPerspective: (value: Perspective) => void;
  scenario: StressScenario;
  setScenario: (value: StressScenario) => void;
  surface: Surface;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border-default bg-surface/70 px-3 py-2 md:px-5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
        Mock controls
      </span>
      {surface === 'chat' && (
        <SegmentedControl
          label="Chat perspective"
          value={perspective}
          onChange={setPerspective}
          options={[
            { value: 'collaborator', label: 'Collaborator', icon: <Users size={12} /> },
            { value: 'owner', label: 'Owner', icon: <CheckCircle2 size={12} /> },
          ]}
        />
      )}
      <label className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
        Data
        <span className="relative">
          <select
            aria-label="Mock data scenario"
            value={scenario}
            onChange={(event) => setScenario(event.target.value as StressScenario)}
            className="h-8 appearance-none rounded-md border border-border-default bg-inset py-1 pl-2.5 pr-7 text-xs text-fg-primary outline-none focus:border-focus-ring"
          >
            <option value="normal">Normal</option>
            <option value="empty">Empty</option>
            <option value="many">32 comments</option>
            <option value="error">Refresh error</option>
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2 top-2 text-fg-muted"
            size={13}
          />
        </span>
      </label>
    </div>
  );
}

function MessageCard({
  message,
  onOpenNotes,
}: {
  message: ChatMessageMock;
  onOpenNotes: (messageId: string) => void;
}) {
  const isOwner = message.role === 'user';
  return (
    <article
      className={`group flex min-w-0 gap-2.5 ${isOwner ? 'ml-6 flex-row-reverse sm:ml-16' : 'mr-2 sm:mr-14'}`}
      data-message-id={message.id}
    >
      <Avatar person={message.author} />
      <div className={`min-w-0 flex-1 ${isOwner ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-fg-muted">
          <span className="font-medium text-fg-primary">{message.author.name}</span>
          <span>{message.time}</span>
        </div>
        <div
          className={`min-w-0 max-w-full rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed shadow-sm md:text-sm ${
            isOwner
              ? 'border-[var(--sam-msg-user-border)] bg-[var(--sam-msg-user-bg)]'
              : 'border-[var(--sam-msg-assistant-border)] bg-[var(--sam-msg-assistant-bg)]'
          }`}
        >
          {message.body.split('\n\n').map((paragraph) => (
            <p key={paragraph.slice(0, 24)} className="m-0 mb-2 last:mb-0">
              {paragraph}
            </p>
          ))}
        </div>
        <div className={`mt-1 flex items-center gap-1 ${isOwner ? 'flex-row-reverse' : ''}`}>
          <button
            type="button"
            onClick={() => onOpenNotes(message.id)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors ${
              message.noteCount > 0
                ? 'border-[var(--sam-color-accent-primary)]/50 bg-accent-primary-tint text-success-fg'
                : 'border-transparent text-fg-muted hover:border-border-default hover:bg-surface'
            }`}
            aria-label={`${message.noteCount > 0 ? `${message.noteCount} collaborator notes` : 'Add collaborator note'} on ${message.author.name}'s message`}
          >
            <MessageCircle size={13} />
            {message.noteCount > 0
              ? `${message.noteCount} ${message.noteCount === 1 ? 'note' : 'notes'}`
              : 'Add note'}
          </button>
          <IconButton label="More message actions">
            <MoreHorizontal size={14} />
          </IconButton>
        </div>
      </div>
    </article>
  );
}

function OwnerReviewTray({
  included,
  setIncluded,
}: {
  included: Set<string>;
  setIncluded: (value: Set<string>) => void;
}) {
  function toggle(id: string) {
    const next = new Set(included);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setIncluded(next);
  }

  return (
    <section className="mb-2 overflow-hidden rounded-lg border border-[var(--sam-color-accent-primary)]/40 bg-[var(--sam-color-accent-primary-tint)] shadow-md">
      <div className="flex items-start gap-2 border-b border-[var(--sam-color-accent-primary)]/20 px-3 py-2.5">
        <Users className="mt-0.5 shrink-0 text-success-fg" size={16} />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm font-semibold text-fg-primary">
            2 notes waiting for your review
          </h3>
          <p className="m-0 mt-0.5 text-[11px] leading-relaxed text-fg-muted">
            Included notes are attached as context to your next message. They do not become prompts
            in the transcript.
          </p>
        </div>
      </div>
      <div className="divide-y divide-border-default/60">
        {CHECKPOINT_NOTES.map((note) => {
          const checked = included.has(note.id);
          return (
            <button
              key={note.id}
              type="button"
              onClick={() => toggle(note.id)}
              className="flex w-full min-w-0 items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface/40"
              aria-pressed={checked}
            >
              <span
                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                  checked ? 'border-accent bg-accent text-white' : 'border-border-default bg-inset'
                }`}
              >
                {checked && <Check size={13} />}
              </span>
              <Avatar person={note.author} size="sm" />
              <span className="min-w-0 flex-1 text-xs leading-relaxed text-fg-primary">
                <strong className="mr-1 font-semibold">{note.author.name}</strong>
                {note.body}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 bg-inset/50 px-3 py-2 text-[11px] text-fg-muted">
        <span>{included.size} selected</span>
        <button type="button" className="font-medium text-fg-primary hover:text-success-fg">
          Mark all reviewed
        </button>
      </div>
    </section>
  );
}

function ConversationCheckpoint({
  perspective,
  onOpen,
}: {
  perspective: Perspective;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-2 py-1 text-left"
      aria-label={
        perspective === 'owner'
          ? 'Review notes at current conversation point'
          : 'Add note at current conversation point'
      }
    >
      <span className="h-px flex-1 bg-border-default transition-colors group-hover:bg-accent" />
      <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border-default bg-inset px-3 text-[11px] text-fg-muted transition-colors group-hover:border-accent group-hover:text-fg-primary">
        <MessageCircle size={12} />
        {perspective === 'owner'
          ? '2 notes at current point'
          : 'Add context before the next prompt'}
      </span>
      <span className="h-px flex-1 bg-border-default transition-colors group-hover:bg-accent" />
    </button>
  );
}

function Composer({
  perspective,
  includedCount,
}: {
  perspective: Perspective;
  includedCount: number;
}) {
  const [value, setValue] = useState('');
  if (perspective === 'collaborator') {
    return (
      <div className="rounded-lg border border-border-default bg-inset px-3 py-2.5">
        <div className="mb-2 flex items-center gap-2 text-xs text-fg-muted">
          <MessageCircle size={14} />
          <span className="font-medium text-fg-primary">Collaborator note</span>
          <span>· visible to everyone in this project</span>
        </div>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={2}
          placeholder="Add context for Raphaël before the next prompt…"
          aria-label="Collaborator note"
          className="block max-h-28 min-h-16 w-full resize-none border-0 bg-transparent p-0 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
        />
        <div className="mt-2 flex items-center gap-2 border-t border-border-default pt-2">
          <IconButton label="Attach file">
            <Paperclip size={15} />
          </IconButton>
          <span className="hidden text-[11px] text-fg-muted sm:inline">
            This does not send a prompt to the agent.
          </span>
          <Button size="sm" className="ml-auto" disabled={!value.trim()}>
            <MessageCircle size={14} /> Add note
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border-default bg-inset px-3 py-2.5">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={2}
        placeholder="Reply to the agent…"
        aria-label="Reply to agent"
        className="block max-h-28 min-h-14 w-full resize-none border-0 bg-transparent p-0 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
      />
      <div className="mt-2 flex items-center gap-2 border-t border-border-default pt-2">
        <IconButton label="Attach file">
          <Paperclip size={15} />
        </IconButton>
        {includedCount > 0 && (
          <span className="min-w-0 truncate text-[11px] text-success-fg">
            {includedCount} collaborator {includedCount === 1 ? 'note' : 'notes'} included
          </span>
        )}
        <Button size="sm" className="ml-auto" disabled={!value.trim()}>
          <Send size={14} /> Send{includedCount > 0 ? ` with ${includedCount}` : ''}
        </Button>
      </div>
    </div>
  );
}

function CommentThread({
  title,
  context,
  comments,
  onClose,
  scenario,
  stale = false,
}: {
  title: string;
  context: string;
  comments: CommentMock[];
  onClose: () => void;
  scenario: StressScenario;
  stale?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const visibleComments =
    scenario === 'empty' ? EMPTY_COMMENTS : scenario === 'many' ? MANY_COMMENTS : comments;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--sam-glass-bg-modal)] backdrop-blur-2xl"
      data-testid="comments-panel"
    >
      <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-default md:hidden" />
      <header className="flex shrink-0 items-start gap-2 border-b border-border-default px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="m-0 truncate text-sm font-semibold text-fg-primary">{title}</h2>
            <span className="rounded-full bg-status-success-bg px-2 py-0.5 text-[10px] font-semibold text-status-success-fg">
              {visibleComments.length}
            </span>
          </div>
          <p className="m-0 mt-1 text-[11px] text-fg-muted">Visible to everyone in this project</p>
        </div>
        <IconButton label="Close comments" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {scenario === 'error' && (
        <div
          className="m-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-tint p-3 text-xs text-warning-fg"
          role="alert"
        >
          <CircleAlert className="mt-0.5 shrink-0" size={15} />
          <span>{ERROR_MESSAGE}</span>
        </div>
      )}
      <div className="shrink-0 border-b border-border-default p-3">
        <div
          className={`rounded-md border-l-2 px-3 py-2 ${stale ? 'border-warning bg-warning-tint' : 'border-accent bg-accent-primary-tint'}`}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
            <Highlighter size={11} /> {stale ? 'Original text · anchor is stale' : 'Commenting on'}
          </div>
          <p className="m-0 line-clamp-3 text-xs italic leading-relaxed text-fg-primary">
            “{context}”
          </p>
          {stale && (
            <button
              type="button"
              className="mt-2 text-[11px] font-semibold text-warning-fg hover:underline"
            >
              Re-anchor comment
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-label="Comment thread">
        {visibleComments.length === 0 ? (
          <div className="flex h-full min-h-36 flex-col items-center justify-center text-center">
            <MessageCircle className="mb-3 text-fg-muted" size={28} />
            <h3 className="m-0 text-sm font-semibold text-fg-primary">Start the conversation</h3>
            <p className="m-0 mt-1 max-w-60 text-xs leading-relaxed text-fg-muted">
              Add the first comment. Everyone with access to this project will be able to read it.
            </p>
          </div>
        ) : (
          visibleComments.map((comment) => (
            <article key={comment.id} className="flex min-w-0 gap-2.5">
              <Avatar person={comment.author} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs font-semibold text-fg-primary">
                    {comment.author.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-fg-muted">{comment.time}</span>
                  {comment.status === 'resolved' && (
                    <span className="ml-auto rounded-full bg-status-muted-bg px-1.5 py-0.5 text-[9px] text-status-muted-fg">
                      Resolved
                    </span>
                  )}
                  {comment.status === 'stale' && (
                    <span className="ml-auto rounded-full bg-warning-tint px-1.5 py-0.5 text-[9px] text-warning-fg">
                      Stale
                    </span>
                  )}
                </div>
                <p className="m-0 mt-1 break-words text-xs leading-relaxed text-fg-primary [overflow-wrap:anywhere]">
                  {comment.body}
                </p>
                <button
                  type="button"
                  className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-fg-muted hover:text-fg-primary"
                >
                  <Reply size={11} /> Reply
                </button>
              </div>
            </article>
          ))
        )}
      </div>
      <footer className="shrink-0 border-t border-border-default bg-inset/80 p-3">
        <div className="rounded-md border border-border-default bg-surface p-2.5 focus-within:border-focus-ring">
          <textarea
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a comment…"
            aria-label="Write a comment"
            className="block max-h-24 min-h-12 w-full resize-none bg-transparent text-xs text-fg-primary outline-none placeholder:text-fg-muted"
          />
          <div className="mt-2 flex items-center justify-between border-t border-border-default pt-2">
            <span className="text-[10px] text-fg-muted">Markdown supported</span>
            <Button size="sm" disabled={!draft.trim()}>
              Comment
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ResponsivePanel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] md:hidden"
        aria-label="Close comments"
        onClick={onClose}
      />
      <aside className="fixed inset-x-0 bottom-0 z-50 h-[76dvh] overflow-hidden rounded-t-2xl border border-border-default shadow-2xl md:static md:z-auto md:h-auto md:w-[360px] md:shrink-0 md:rounded-none md:border-y-0 md:border-r-0 md:border-l">
        {children}
      </aside>
    </>
  );
}

function ChatSurface({
  perspective,
  scenario,
}: {
  perspective: Perspective;
  scenario: StressScenario;
}) {
  const defaultPanel = initialParam('panel', ['open', 'closed'] as const, 'open') === 'open';
  const [panelOpen, setPanelOpen] = useState(defaultPanel);
  const [selectedMessageId, setSelectedMessageId] = useState<string | 'checkpoint'>('message-2');
  const [included, setIncluded] = useState(new Set(CHECKPOINT_NOTES.map((note) => note.id)));

  const selectedMessage = CHAT_MESSAGES.find((message) => message.id === selectedMessageId);
  const comments =
    selectedMessageId === 'checkpoint'
      ? CHECKPOINT_NOTES
      : (MESSAGE_NOTES[selectedMessageId] ?? []);
  const context =
    selectedMessageId === 'checkpoint'
      ? 'Current conversation point — after the latest owner message and before the next prompt'
      : (selectedMessage?.body ?? 'Selected message');

  function openNotes(id: string | 'checkpoint') {
    setSelectedMessageId(id);
    setPanelOpen(true);
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col bg-page" aria-label="Shared chat prototype">
        <div className="flex shrink-0 items-center gap-3 border-b border-border-default bg-canvas/40 px-3 py-2.5 md:px-5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary-tint text-success-fg">
            <Bot size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="m-0 truncate text-sm font-semibold text-fg-primary">
              Comments UX planning
            </h1>
            <p className="m-0 truncate text-[11px] text-fg-muted">
              {perspective === 'owner' ? 'You own this session' : 'Raphaël owns this session'} ·
              Codex is ready
            </p>
          </div>
          <button
            type="button"
            onClick={() => openNotes('checkpoint')}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border-default bg-inset px-2.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
          >
            <MessageCircle size={14} />
            <span className="hidden sm:inline">Notes</span>
            <span className="rounded-full bg-status-success-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-success-fg">
              4
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div className="flex items-center gap-2 py-1 text-[10px] text-fg-muted">
              <span className="h-px flex-1 bg-border-default" /> Today, 18:42{' '}
              <span className="h-px flex-1 bg-border-default" />
            </div>
            {CHAT_MESSAGES.map((message) => (
              <MessageCard key={message.id} message={message} onOpenNotes={openNotes} />
            ))}
            <ConversationCheckpoint
              perspective={perspective}
              onOpen={() => openNotes('checkpoint')}
            />
          </div>
        </div>
        <div className="shrink-0 border-t border-border-default bg-[var(--sam-glass-bg-chrome)] p-3 backdrop-blur-xl md:px-6 md:py-4">
          <div className="mx-auto max-w-3xl">
            {perspective === 'owner' && (
              <OwnerReviewTray included={included} setIncluded={setIncluded} />
            )}
            <Composer perspective={perspective} includedCount={included.size} />
          </div>
        </div>
      </main>
      {panelOpen && (
        <ResponsivePanel onClose={() => setPanelOpen(false)}>
          <CommentThread
            title={
              selectedMessageId === 'checkpoint' ? 'Current conversation point' : 'Message notes'
            }
            context={context}
            comments={comments}
            onClose={() => setPanelOpen(false)}
            scenario={scenario}
          />
        </ResponsivePanel>
      )}
    </div>
  );
}

function InlineAnchor({
  children,
  anchor,
  onOpen,
}: {
  children: ReactNode;
  anchor: LibraryAnchorMock;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative inline rounded px-0.5 text-left text-inherit underline decoration-2 underline-offset-[3px] ${
        anchor.status === 'stale'
          ? 'bg-warning-tint decoration-warning/70'
          : 'bg-accent-primary-tint decoration-accent/70'
      }`}
    >
      {children}
      <span className="ml-1 inline-flex translate-y-[-1px] items-center gap-0.5 rounded-full bg-surface px-1.5 py-0.5 align-middle text-[9px] font-semibold text-success-fg shadow-sm ring-1 ring-border-default">
        <MessageCircle size={9} /> {anchor.commentCount}
      </span>
    </button>
  );
}

function MarkdownDocument({ onOpen }: { onOpen: (anchor: LibraryAnchorMock) => void }) {
  return (
    <article className="mx-auto w-full max-w-[760px] px-4 py-6 text-sm leading-relaxed text-fg-primary md:px-8 md:py-10">
      <h1 className="m-0 mb-5 text-2xl font-bold leading-tight">Multiplayer comments rollout</h1>
      <p className="mb-5">
        Comments should help collaborators contribute context without impersonating the person who
        owns the agent session.
      </p>
      <h2 className="mb-3 mt-7 text-xl font-semibold">First release</h2>
      <p className="mb-5">
        The first release should make the handoff explicit:{' '}
        <InlineAnchor anchor={LIBRARY_ANCHORS[0]} onOpen={() => onOpen(LIBRARY_ANCHORS[0])}>
          collaborators leave notes, the session owner reviews them, and only selected notes are
          attached to the next agent turn.
        </InlineAnchor>
      </p>
      <h3 className="mb-3 mt-7 text-base font-semibold">Design principles</h3>
      <ul className="space-y-2 pl-5">
        <li>Human notes stay visually distinct from prompts and agent responses.</li>
        <li>Everyone in the project can read the same threads.</li>
        <li>
          <InlineAnchor anchor={LIBRARY_ANCHORS[1]} onOpen={() => onOpen(LIBRARY_ANCHORS[1])}>
            Anchors survive ordinary edits when possible
          </InlineAnchor>{' '}
          and become visibly stale when they cannot be matched safely.
        </li>
        <li>Mobile is the primary review experience.</li>
      </ul>
      <h2 className="mb-3 mt-8 text-xl font-semibold">Open question</h2>
      <p>
        Should resolved notes disappear from the default view, or remain collapsed near their
        original anchor?
      </p>
    </article>
  );
}

function CodeDocument({ onOpen }: { onOpen: (anchor: LibraryAnchorMock) => void }) {
  const lines = CODE_CONTENT.split('\n');
  return (
    <div className="min-w-max py-4 font-mono text-[12px] leading-6 text-[#d6deeb] md:py-6 md:text-[13px]">
      {lines.map((line, index) => {
        const isAnchored = index >= 6 && index <= 8;
        return (
          <button
            key={`${index}-${line}`}
            type="button"
            onClick={isAnchored ? () => onOpen(CODE_ANCHOR) : undefined}
            className={`group flex w-full min-w-full items-stretch border-l-2 text-left ${
              isAnchored
                ? 'border-accent bg-accent-primary-tint'
                : 'border-transparent hover:bg-white/[0.03]'
            }`}
            aria-label={isAnchored ? `Open 2 comments on line ${index + 1}` : undefined}
          >
            <span className="w-12 shrink-0 select-none pr-3 text-right text-[#637777]">
              {index + 1}
            </span>
            <code className="whitespace-pre pr-5">{line || ' '}</code>
            {index === 7 && (
              <span className="sticky right-2 ml-auto mr-2 inline-flex h-5 items-center gap-1 self-center rounded-full bg-accent px-1.5 font-sans text-[9px] font-semibold text-white shadow-md">
                <MessageCircle size={9} /> 2
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function LibrarySurface({ scenario }: { scenario: StressScenario }) {
  const initialFile = initialParam('file', ['markdown', 'code'] as const, 'markdown');
  const initialView = initialParam('view', ['rendered', 'source'] as const, 'rendered');
  const defaultPanel = initialParam('panel', ['open', 'closed'] as const, 'open') === 'open';
  const [file, setFile] = useState<LibraryFile>(initialFile);
  const [view, setView] = useState<FileView>(initialView);
  const [selectedAnchor, setSelectedAnchor] = useState<LibraryAnchorMock>(
    initialFile === 'code' ? CODE_ANCHOR : LIBRARY_ANCHORS[0]
  );
  const [panelOpen, setPanelOpen] = useState(defaultPanel);

  function openAnchor(anchor: LibraryAnchorMock) {
    setSelectedAnchor(anchor);
    setPanelOpen(true);
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-page">
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Library comments prototype">
        <header className="shrink-0 border-b border-border-default bg-[var(--sam-glass-bg-chrome)] px-3 py-2.5 backdrop-blur-xl md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <IconButton label="Back to Library">
              <ArrowLeft size={16} />
            </IconButton>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                {file === 'markdown' ? (
                  <FileText className="shrink-0 text-success-fg" size={16} />
                ) : (
                  <Code2 className="shrink-0 text-tn-blue" size={16} />
                )}
                <h1 className="m-0 truncate text-sm font-semibold text-fg-primary">
                  {file === 'markdown' ? 'comments-rollout.md' : 'assemble-next-turn.ts'}
                </h1>
                <span className="hidden rounded-full border border-border-default px-2 py-0.5 text-[10px] text-fg-muted sm:inline">
                  Updated 4m ago
                </span>
              </div>
              <p className="m-0 mt-0.5 truncate text-[10px] text-fg-muted">
                /product/research/comments/
              </p>
            </div>
            <IconButton label="Open comments" onClick={() => setPanelOpen(true)} active={panelOpen}>
              <MessageCircle size={16} />
            </IconButton>
            <IconButton label="More file actions">
              <MoreHorizontal size={16} />
            </IconButton>
          </div>
          <div className="mt-2 flex items-center gap-2 overflow-x-auto">
            <SegmentedControl
              label="Mock file"
              value={file}
              onChange={(value) => {
                setFile(value);
                setSelectedAnchor(value === 'code' ? CODE_ANCHOR : LIBRARY_ANCHORS[0]);
                if (value === 'code') setView('source');
              }}
              options={[
                { value: 'markdown', label: 'Markdown', icon: <FileText size={12} /> },
                { value: 'code', label: 'Code', icon: <Code2 size={12} /> },
              ]}
            />
            {file === 'markdown' && (
              <SegmentedControl
                label="Markdown view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'rendered', label: 'Rendered' },
                  { value: 'source', label: 'Source' },
                ]}
              />
            )}
            <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-[10px] text-fg-muted lg:flex">
              <Highlighter size={12} /> Select text to comment
            </span>
          </div>
        </header>
        <div
          className={`min-h-0 flex-1 overflow-auto ${file === 'code' ? 'bg-[#011627]' : 'bg-page'}`}
          data-testid="file-document"
        >
          {file === 'markdown' && view === 'rendered' && <MarkdownDocument onOpen={openAnchor} />}
          {file === 'markdown' && view === 'source' && (
            <div className="mx-auto max-w-[900px] bg-[#011627]">
              <pre className="m-0 overflow-auto p-4 font-mono text-[12px] leading-6 text-[#d6deeb] md:p-7">
                {MARKDOWN_CONTENT}
              </pre>
            </div>
          )}
          {file === 'code' && <CodeDocument onOpen={openAnchor} />}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border-default bg-canvas px-3 py-2 text-[10px] text-fg-muted md:px-5">
          <span>UTF-8</span>
          <span>·</span>
          <span>{file === 'markdown' ? 'Markdown' : 'TypeScript'}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-success-fg">
            <MessageCircle size={11} />{' '}
            {file === 'markdown' ? '4 comments in 2 threads' : '2 comments on lines 7–9'}
          </span>
        </div>
      </main>
      {panelOpen && (
        <ResponsivePanel onClose={() => setPanelOpen(false)}>
          <CommentThread
            title={file === 'code' ? 'Code comments' : 'File comments'}
            context={selectedAnchor.quote}
            comments={selectedAnchor.comments}
            onClose={() => setPanelOpen(false)}
            scenario={scenario}
            stale={selectedAnchor.status === 'stale'}
          />
        </ResponsivePanel>
      )}
    </div>
  );
}

export function CommentsPrototype() {
  const [surface, setSurface] = useState<Surface>(() =>
    initialParam('surface', ['chat', 'library'] as const, 'chat')
  );
  const [perspective, setPerspective] = useState<Perspective>(() =>
    initialParam('role', ['collaborator', 'owner'] as const, 'collaborator')
  );
  const [scenario, setScenario] = useState<StressScenario>(() =>
    initialParam('scenario', ['normal', 'empty', 'many', 'error'] as const, 'normal')
  );

  const key = useMemo(() => `${surface}-${perspective}`, [surface, perspective]);

  return (
    <div
      style={{ height: '100vh', overflow: 'auto' }}
      className="flex min-w-0 flex-col bg-canvas text-fg-primary"
      data-ui-theme="sam"
      data-testid="comments-prototype"
    >
      <PrototypeChrome surface={surface} setSurface={setSurface} />
      <PrototypeControls
        perspective={perspective}
        setPerspective={setPerspective}
        scenario={scenario}
        setScenario={setScenario}
        surface={surface}
      />
      <div key={key} className="flex min-h-0 flex-1 flex-col">
        {surface === 'chat' ? (
          <ChatSurface perspective={perspective} scenario={scenario} />
        ) : (
          <LibrarySurface scenario={scenario} />
        )}
      </div>
    </div>
  );
}
