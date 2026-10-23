/**
 * Ideas redesign prototype: "Start work" replaces Execute (throwaway; never merge to main).
 *
 * The person picks who works on the idea, optionally a skill, and adds a note. The idea and
 * its history travel as structured context; no prompt text with a repository-specific
 * command is ever shown or typed. The sentence above the buttons says exactly what will happen.
 */
import { Button } from '@simple-agent-manager/ui';
import { Check, ChevronDown, CircleAlert, Sparkles, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { BRAINSTORMER, CONTEXT_ITEMS, DO_SKILL, OPUS, START_NOTE, STORY_IDEA_TITLE } from './mock-data';
import { AuthorAvatar, tint } from './parts';

function Field({ label, optional, children }: { label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-fg-muted">
        {label}
        {optional && <span className="font-normal"> · optional</span>}
      </span>
      {children}
    </div>
  );
}

/** A select-style row: the current choice, and a clear way to change it. */
function Choice({
  icon,
  title,
  detail,
  badge,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex min-h-[52px] w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 py-1.5 text-left hover:border-accent/50"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-fg-primary">{title}</span>
          {badge}
        </span>
        <span className="truncate text-[13px] text-fg-muted">{detail}</span>
      </span>
      <ChevronDown size={18} aria-hidden className="shrink-0 text-fg-muted" />
    </button>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'warn'; children: ReactNode }) {
  const color = tone === 'ok' ? 'var(--sam-color-success-fg)' : 'var(--sam-color-warning-fg)';
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: tint(color, 15), color }}
    >
      {children}
    </span>
  );
}

export function StartWorkSheet({ variant }: { variant: 'work' | 'chat' }) {
  const isMobile = useIsMobile();
  const profile = variant === 'work' ? OPUS : BRAINSTORMER;
  const skill = variant === 'work' ? DO_SKILL : null;
  const canChangeCode = profile.canChangeCode;

  const outcome = canChangeCode ? (
    <>
      <strong>{profile.name}</strong> starts a new chat
      {skill ? (
        <>
          {' '}
          with the <strong>{skill.name}</strong> skill
        </>
      ) : null}
      . The idea moves to <strong>In progress</strong>, and the chat and any pull request show up on
      it.
    </>
  ) : (
    <>
      <strong>{profile.name}</strong> can’t change code, so this only starts a conversation. The
      idea stays Not started.
    </>
  );

  return (
    <div
      className={`fixed inset-0 z-dialog-backdrop flex justify-center ${isMobile ? 'items-end' : 'items-center p-4'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Start work"
    >
      <div className="fixed inset-0 bg-overlay glass-backdrop-dim" aria-hidden />
      <div
        className={`glass-panel-container glass-composited relative flex w-full flex-col glass-modal shadow-overlay ${
          isMobile ? 'max-h-[92dvh] rounded-t-2xl' : 'max-h-[calc(100dvh-2rem)] max-w-[540px] rounded-2xl'
        }`}
      >
        {isMobile && (
          <span className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-border-default" aria-hidden />
        )}
        <header className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="m-0 text-[19px] font-bold text-fg-primary">
              {canChangeCode ? 'Start work' : 'Talk it through'}
            </h2>
            <p className="m-0 truncate text-[13px] text-fg-muted">{STORY_IDEA_TITLE}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-surface-hover"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-3">
          <Field label="Who works on it">
            <Choice
              icon={<AuthorAvatar name={profile.name} kind="agent" size="lg" />}
              title={profile.name}
              detail={profile.description}
              badge={canChangeCode ? <Pill tone="ok">Can change code</Pill> : <Pill tone="warn">Chat only</Pill>}
            />
          </Field>

          {canChangeCode && (
            <Field label="Skill" optional>
              <Choice
                icon={
                  <span
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: tint('var(--sam-color-purple)'), color: 'var(--sam-color-purple)' }}
                    aria-hidden
                  >
                    <Sparkles size={18} />
                  </span>
                }
                title={skill ? skill.name : 'No skill'}
                detail={skill ? skill.description : 'The agent decides how to work'}
              />
            </Field>
          )}

          <Field label="Note for the agent" optional>
            <textarea
              rows={2}
              defaultValue={canChangeCode ? START_NOTE : ''}
              placeholder="Your note is the only message you send. The idea goes along on its own."
              className="min-h-[56px] w-full resize-none rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 py-2.5 text-[15px] leading-snug text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </Field>

          <Field label={`${profile.name} starts with`}>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {CONTEXT_ITEMS.map((item) => (
                <li
                  key={item}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-default bg-surface-hover px-2.5 py-0.5 text-[13px] text-fg-primary"
                >
                  <Check size={13} aria-hidden className="shrink-0 text-success-fg" />
                  <span className="truncate">{item}</span>
                </li>
              ))}
            </ul>
          </Field>
        </div>

        <footer className="flex shrink-0 flex-col gap-3 border-0 border-t border-solid border-border-default px-5 pb-4 pt-3">
          <p
            className={`m-0 flex gap-2 text-[13px] leading-relaxed ${canChangeCode ? 'text-fg-muted' : 'text-fg-primary'}`}
          >
            {!canChangeCode && <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0 text-warning-fg" />}
            <span>{outcome}</span>
          </p>
          <div className={`flex gap-3 ${isMobile ? '' : 'justify-end'}`}>
            <Button variant="ghost">Cancel</Button>
            <Button className={isMobile ? 'flex-1' : ''}>{canChangeCode ? 'Start work' : 'Start chat'}</Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
